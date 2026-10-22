import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { validateProxyAuth } from "./auth.js";
import { loadConfig, type Config } from "./config.js";
import { chatFinishReason, chatToResponsesPayload, responsesToChatCompletion, toChatUsage, toolCallId } from "./chat.js";
import { errorResponse, HttpError, isPlainObject, notImplemented, readJson, requireObject, sendJson } from "./http.js";
import { CodexResponsesForwarder, upstreamFailureMessage, type ResponsesForwarder } from "./responses.js";
import { TokenManager } from "./upstream.js";

export interface AppDeps {
  config: Config;
  forwarder: ResponsesForwarder;
}

export function createApp(deps: AppDeps) {
  return async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, { status: 200, body: { ok: true } });
        return;
      }

      validateProxyAuth(req.headers, deps.config.proxyApiKey);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, {
          status: 200,
          body: {
            object: "list",
            data: deps.config.codexModels.map((id) => ({
              id,
              object: "model",
              created: 0,
              owned_by: "openai"
            }))
          }
        });
        return;
      }

      if (url.pathname === "/v1/files" || url.pathname.startsWith("/v1/files/")) {
        sendJson(res, notImplemented("/v1/files is not implemented; pass file content as Responses input_file parts instead"));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const payload = requireObject(await readJson(req));
        if (payload.stream === true) {
          await sendResponsesStream(res, await deps.forwarder.stream(payload));
          return;
        }
        const upstream = await deps.forwarder.forward({ ...payload, stream: false });
        sendJson(res, { status: 200, body: upstream });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = requireObject(await readJson(req));
        const responsesPayload = chatToResponsesPayload(payload);
        if (payload.stream === true) {
          const streamOptions = payload.stream_options;
          const includeUsage = isPlainObject(streamOptions) && streamOptions.include_usage === true;
          await sendChatCompletionStream(
            res,
            await deps.forwarder.stream(responsesPayload),
            responsesPayload.model,
            includeUsage
          );
          return;
        }
        const upstream = await deps.forwarder.forward({ ...responsesPayload, stream: false });
        sendJson(res, {
          status: 200,
          body: responsesToChatCompletion(upstream, responsesPayload.model)
        });
        return;
      }

      throw new HttpError(404, "not_found", "Route not found");
    } catch (error) {
      sendJson(res, errorResponse(error));
    }
  };
}

async function sendResponsesStream(res: ServerResponse, upstream: Response): Promise<void> {
  writeSseHead(res);
  await pipeReadableStream(upstream.body, res);
}

interface StreamedToolCall {
  index: number;
  arguments: string;
}

async function sendChatCompletionStream(
  res: ServerResponse,
  upstream: Response,
  model: string,
  includeUsage = false
): Promise<void> {
  writeSseHead(res);

  const id = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const write = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
    writeChatChunk(res, { id, created, model, delta, finishReason });
  };
  write({ role: "assistant" });

  // Tool calls are looked up by upstream item id and output index, so argument
  // deltas always land on the chat tool_call they belong to.
  const toolCalls: StreamedToolCall[] = [];
  const toolCallsByKey = new Map<string, StreamedToolCall>();
  let finalResponse: Record<string, unknown> | undefined;
  let failure: string | undefined;

  const startToolCall = (item: Record<string, unknown>, keys: string[], args: string): void => {
    const call = { index: toolCalls.length, arguments: args };
    toolCalls.push(call);
    for (const key of keys) toolCallsByKey.set(key, call);
    write({
      tool_calls: [{
        index: call.index,
        id: toolCallId(item),
        type: "function",
        function: { name: typeof item.name === "string" ? item.name : "", arguments: args }
      }]
    });
  };

  const appendArguments = (call: StreamedToolCall, delta: string): void => {
    if (!delta) return;
    call.arguments += delta;
    write({ tool_calls: [{ index: call.index, function: { arguments: delta } }] });
  };

  const findToolCall = (keys: string[]): StreamedToolCall | undefined => {
    for (const key of keys) {
      const call = toolCallsByKey.get(key);
      if (call) return call;
    }
    return undefined;
  };

  const handleEvent = (event: Record<string, unknown>): void => {
    if (failure !== undefined) return;

    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string") write({ content: event.delta });
        return;

      case "response.output_item.added":
        if (isFunctionCall(event.item)) {
          const keys = toolCallKeys(event, event.item);
          if (!findToolCall(keys)) startToolCall(event.item, keys, "");
        }
        return;

      case "response.function_call_arguments.delta": {
        // Deltas for a call that was never announced are dropped here;
        // response.output_item.done delivers that call in full.
        const call = findToolCall(toolCallKeys(event));
        if (call && typeof event.delta === "string") appendArguments(call, event.delta);
        return;
      }

      case "response.output_item.done":
        if (isFunctionCall(event.item)) {
          const keys = toolCallKeys(event, event.item);
          const finalArguments = typeof event.item.arguments === "string" ? event.item.arguments : "";
          const call = findToolCall(keys);
          if (!call) {
            startToolCall(event.item, keys, finalArguments);
          } else if (finalArguments.startsWith(call.arguments)) {
            appendArguments(call, finalArguments.slice(call.arguments.length));
          }
        }
        return;

      case "response.completed":
      case "response.incomplete":
        finalResponse = isPlainObject(event.response) ? event.response : {};
        return;

      case "response.failed":
        failure = upstreamFailureMessage(isPlainObject(event.response) ? event.response.error : undefined);
        return;

      case "error":
        failure = upstreamFailureMessage(event);
        return;
    }
  };

  const decoder = new TextDecoder();
  let buffer = "";

  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = processResponsesSseBlocks(buffer, handleEvent);
      }
      if (buffer) {
        processResponsesSseBlocks(`${buffer}\n\n`, handleEvent);
      }
    } catch {
      failure ??= "Codex upstream stream was interrupted";
    } finally {
      reader.releaseLock();
    }
  }

  if (failure === undefined && finalResponse === undefined) {
    failure = "Codex upstream stream ended before the response completed";
  }

  if (failure !== undefined) {
    // Headers are already sent, so report the failure in-band the way OpenAI
    // does; OpenAI SDKs raise an error when a chunk carries an `error` field.
    res.write(`data: ${JSON.stringify({ error: { type: "upstream_error", message: failure } })}\n\n`);
    res.end();
    return;
  }

  write({}, chatFinishReason(finalResponse, toolCalls.length > 0));

  const usage = includeUsage ? toChatUsage(finalResponse?.usage) : undefined;
  if (usage) {
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

function toolCallKeys(event: Record<string, unknown>, item?: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const itemId = item?.id ?? event.item_id;
  if (typeof itemId === "string") keys.push(`id:${itemId}`);
  if (typeof event.output_index === "number") keys.push(`index:${event.output_index}`);
  return keys;
}

function isFunctionCall(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && value.type === "function_call";
}

function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
}

async function pipeReadableStream(stream: ReadableStream<Uint8Array> | null, res: ServerResponse): Promise<void> {
  if (!stream) {
    res.end();
    return;
  }

  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

function processResponsesSseBlocks(buffer: string, onEvent: (event: Record<string, unknown>) => void): string {
  let remaining = buffer;
  let separatorIndex = remaining.search(/\r?\n\r?\n/);

  while (separatorIndex !== -1) {
    const block = remaining.slice(0, separatorIndex);
    const separator = remaining.match(/\r?\n\r?\n/);
    remaining = remaining.slice(separatorIndex + (separator?.[0].length ?? 2));

    const event = parseResponsesSseBlock(block);
    if (event) onEvent(event);

    separatorIndex = remaining.search(/\r?\n\r?\n/);
  }

  return remaining;
}

function parseResponsesSseBlock(block: string): Record<string, unknown> | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");

  if (!data || data === "[DONE]") return undefined;

  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface ChatChunkOptions {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
}

function writeChatChunk(res: ServerResponse, options: ChatChunkOptions): void {
  res.write(`data: ${JSON.stringify({
    id: options.id,
    object: "chat.completion.chunk",
    created: options.created,
    model: options.model,
    choices: [
      {
        index: 0,
        delta: options.delta,
        finish_reason: options.finishReason
      }
    ]
  })}\n\n`);
}

export function startServer(config = loadConfig()): void {
  const tokenManager = new TokenManager(config);
  const forwarder = new CodexResponsesForwarder(config, tokenManager);
  const server = createServer(createApp({ config, forwarder }));

  server.listen(config.port, config.host, () => {
    console.log(`codex-sub-proxy listening on http://${config.host}:${config.port}`);
    if (!config.proxyApiKey) {
      console.warn("PROXY_API_KEY is unset; caller authentication is disabled and unsafe outside local dev.");
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
