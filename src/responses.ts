import { CodexBackendV1Adapter, type UpstreamObserver } from "./codex-adapter.js";
import type { Config } from "./config.js";
import { HttpError } from "./http.js";
import { collectResponsesSse } from "./sse.js";
import type { TokenManager } from "./upstream.js";

export interface ForwardOptions {
  signal?: AbortSignal;
}

export interface ResponsesForwarder {
  forward(payload: Record<string, unknown>, options?: ForwardOptions): Promise<unknown>;
  stream(payload: Record<string, unknown>, options?: ForwardOptions): Promise<Response>;
}

export class CodexResponsesForwarder implements ResponsesForwarder {
  private readonly adapter: CodexBackendV1Adapter;
  private readonly responseTimeoutMs: number;

  constructor(
    config: Config,
    tokenManager: TokenManager,
    fetchImpl: typeof fetch = fetch,
    observer?: UpstreamObserver,
  ) {
    this.adapter = new CodexBackendV1Adapter(config, tokenManager, fetchImpl, observer);
    this.responseTimeoutMs = config.upstreamResponseTimeoutMs;
  }

  async forward(payload: Record<string, unknown>, options: ForwardOptions = {}): Promise<unknown> {
    const response = await this.stream(payload, options);
    return readUpstreamResponse(response, options.signal, this.responseTimeoutMs);
  }

  stream(payload: Record<string, unknown>, options: ForwardOptions = {}): Promise<Response> {
    return this.adapter.createResponse(payload, options.signal);
  }
}
async function readUpstreamResponse(
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const text = await readTextWithDeadline(response, signal, timeoutMs);
  if (!text) return {};

  const trimmed = text.trimStart();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    return collectResponsesSse(text);
  }

  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new HttpError(502, "upstream_protocol_error", "Codex upstream returned malformed response JSON");
  }
}

async function readTextWithDeadline(
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (combined.aborted) throw combined.reason;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let completed = false;
  try {
    while (true) {
      const result = await readWithSignal(reader, combined);
      if (result.done) {
        completed = true;
        break;
      }
      chunks.push(result.value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
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
