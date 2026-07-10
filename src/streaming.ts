import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { responsesUsageToChatUsage } from "./chat.js";
import type { ResponsesEvent } from "./schemas.js";
import { assertSuccessfulEvent, ResponsesSseDecoder } from "./sse.js";

export interface StreamOptions {
  signal?: AbortSignal;
  idleTimeoutMs: number;
  includeUsage?: boolean;
}

export async function sendResponsesStream(
  res: ServerResponse,
  upstream: Response,
  options: StreamOptions,
): Promise<void> {
  writeSseHead(res);
  await pipeReadableStream(upstream.body, res, options);
}

export async function sendChatCompletionStream(
  res: ServerResponse,
  upstream: Response,
  model: string,
  options: StreamOptions,
): Promise<void> {
  writeSseHead(res);
  const id = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  await writeChatChunk(res, { id, created, model, delta: { role: "assistant" }, finishReason: null });

  const decoder = new ResponsesSseDecoder();
  const state: ChatStreamState = {
    finishReason: "stop",
    toolCalls: false,
    toolIndices: new Map(),
    nextToolIndex: 0,
  };
  if (upstream.body) {
    const reader = upstream.body.getReader();
    let completed = false;
    try {
      while (true) {
        const result = await readWithDeadline(reader, options);
        if (result.done) {
          completed = true;
          break;
        }
        for (const event of decoder.push(result.value)) {
          assertSuccessfulEvent(event);
          await writeChatEvent(res, { id, created, model }, event, state);
        }
      }
      for (const event of decoder.finish()) {
        assertSuccessfulEvent(event);
        await writeChatEvent(res, { id, created, model }, event, state);
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  await writeChatChunk(res, { id, created, model, delta: {}, finishReason: state.finishReason });
  if (options.includeUsage && state.usage !== undefined) {
    await writeWithBackpressure(
      res,
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: state.usage,
      })}\n\n`,
    );
  }
  await writeWithBackpressure(res, "data: [DONE]\n\n");
  res.end();
}

async function pipeReadableStream(
  stream: ReadableStream<Uint8Array> | null,
  res: ServerResponse,
  options: StreamOptions,
): Promise<void> {
  if (!stream) {
    res.end();
    return;
  }
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const result = await readWithDeadline(reader, options);
      if (result.done) {
        completed = true;
        break;
      }
      await writeWithBackpressure(res, Buffer.from(result.value));
    }
    res.end();
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: StreamOptions,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  const timeout = AbortSignal.timeout(options.idleTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}

async function writeChatEvent(
  res: ServerResponse,
  base: Pick<ChatChunkOptions, "id" | "created" | "model">,
  event: ResponsesEvent,
  state: ChatStreamState,
): Promise<void> {
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    await writeChatChunk(res, { ...base, delta: { content: event.delta }, finishReason: null });
  }
  if (event.type === "response.refusal.delta" && typeof event.delta === "string") {
    await writeChatChunk(res, { ...base, delta: { refusal: event.delta }, finishReason: null });
  }
  if (event.type === "response.output_text.annotation.added" && event.annotation !== undefined) {
    await writeChatChunk(res, { ...base, delta: { annotations: [event.annotation] }, finishReason: null });
  }
  if (event.type === "response.output_item.added" && event.item) {
    if (event.item.type === "function_call") {
      const outputIndex = event.output_index ?? 0;
      const index = chatToolIndex(state, outputIndex);
      const id = typeof event.item.call_id === "string" ? event.item.call_id : `call_${outputIndex}`;
      const name = typeof event.item.name === "string" ? event.item.name : "unknown";
      state.toolCalls = true;
      state.finishReason = "tool_calls";
      await writeChatChunk(res, {
        ...base,
        delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] },
        finishReason: null,
      });
    } else if (event.item.type !== "message" && event.item.type !== "reasoning") {
      await writeChatChunk(res, { ...base, delta: { response_output: [event.item] }, finishReason: null });
    }
  }
  if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
    state.toolCalls = true;
    state.finishReason = "tool_calls";
    await writeChatChunk(res, {
      ...base,
      delta: {
        tool_calls: [{ index: chatToolIndex(state, event.output_index ?? 0), function: { arguments: event.delta } }],
      },
      finishReason: null,
    });
  }
  if (event.type === "response.incomplete") state.finishReason = "length";
  if (event.type === "response.completed" && event.response) {
    if (event.response.status === "incomplete" && !state.toolCalls) state.finishReason = "length";
    state.usage = responsesUsageToChatUsage(event.response);
  }
}

interface ChatStreamState {
  finishReason: string;
  toolCalls: boolean;
  usage?: unknown;
  toolIndices: Map<number, number>;
  nextToolIndex: number;
}

function chatToolIndex(state: ChatStreamState, outputIndex: number): number {
  const existing = state.toolIndices.get(outputIndex);
  if (existing !== undefined) return existing;
  const index = state.nextToolIndex;
  state.nextToolIndex += 1;
  state.toolIndices.set(outputIndex, index);
  return index;
}

interface ChatChunkOptions {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
}

async function writeChatChunk(res: ServerResponse, options: ChatChunkOptions): Promise<void> {
  await writeWithBackpressure(
    res,
    `data: ${JSON.stringify({
      id: options.id,
      object: "chat.completion.chunk",
      created: options.created,
      model: options.model,
      choices: [{ index: 0, delta: options.delta, finish_reason: options.finishReason }],
    })}\n\n`,
  );
}

async function writeWithBackpressure(res: ServerResponse, chunk: string | Buffer): Promise<void> {
  if (res.destroyed) throw new Error("Downstream connection closed");
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Downstream connection closed"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}
