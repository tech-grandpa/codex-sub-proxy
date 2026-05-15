import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { validateProxyAuth } from "./auth.js";
import { loadConfig, type Config } from "./config.js";
import { chatToResponsesPayload, responsesToChatCompletion } from "./chat.js";
import { errorResponse, HttpError, notImplemented, readJson, requireObject, sendJson } from "./http.js";
import { CodexResponsesForwarder, type ResponsesForwarder } from "./responses.js";
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
          await sendChatCompletionStream(res, await deps.forwarder.stream(responsesPayload), responsesPayload.model);
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

async function sendChatCompletionStream(res: ServerResponse, upstream: Response, model: string): Promise<void> {
  writeSseHead(res);

  const id = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  writeChatChunk(res, { id, created, model, delta: { role: "assistant" }, finishReason: null });

  const decoder = new TextDecoder();
  let buffer = "";

  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = processResponsesSseBlocks(buffer, (event) => {
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            writeChatChunk(res, { id, created, model, delta: { content: event.delta }, finishReason: null });
          }
        });
      }
    } finally {
      reader.releaseLock();
    }
  }

  if (buffer) {
    processResponsesSseBlocks(`${buffer}\n\n`, (event) => {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        writeChatChunk(res, { id, created, model, delta: { content: event.delta }, finishReason: null });
      }
    });
  }

  writeChatChunk(res, { id, created, model, delta: {}, finishReason: "stop" });
  res.write("data: [DONE]\n\n");
  res.end();
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
