import { type Config, USER_AGENT } from "./config.js";
import { HttpError } from "./http.js";
import { stripUnsupportedParams } from "./strip.js";
import { buildResponsesUrl, type TokenManager } from "./upstream.js";

export type UpstreamResult =
  | "success"
  | "auth"
  | "rate_limited"
  | "rejected"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "network";

export interface UpstreamObserver {
  record(result: UpstreamResult, durationMs: number): void;
}

export class CodexBackendV1Adapter {
  private readonly config: Config;
  private readonly tokenManager: TokenManager;
  private readonly fetchImpl: typeof fetch;
  private readonly observer?: UpstreamObserver;

  constructor(
    config: Config,
    tokenManager: TokenManager,
    fetchImpl: typeof fetch = fetch,
    observer?: UpstreamObserver,
  ) {
    this.config = config;
    this.tokenManager = tokenManager;
    this.fetchImpl = fetchImpl;
    this.observer = observer;
  }

  async createResponse(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const started = performance.now();
    try {
      let token = await this.tokenManager.getAccessToken();
      let response = await this.send(payload, token, signal);
      if (response.status === 401) {
        await response.body?.cancel();
        await this.tokenManager.invalidateAccessToken(token);
        token = await this.tokenManager.getAccessToken();
        response = await this.send(payload, token, signal);
      }
      if (!response.ok) {
        const result = classifyStatus(response.status);
        this.observer?.record(result, performance.now() - started);
        await response.body?.cancel();
        throw statusError(response.status, result);
      }
      this.observer?.record("success", performance.now() - started);
      return response;
    } catch (error) {
      if (!(error instanceof HttpError)) {
        const result =
          error instanceof DOMException && error.name === "TimeoutError"
            ? "timeout"
            : signal?.aborted
              ? "cancelled"
              : "network";
        this.observer?.record(result, performance.now() - started);
      }
      throw error;
    }
  }

  private async send(payload: Record<string, unknown>, accessToken: string, signal?: AbortSignal): Promise<Response> {
    const body = {
      ...normalizePayload(stripUnsupportedParams(payload)),
      store: false,
      stream: true,
    };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      originator: "codex-sub-proxy",
    };
    if (this.config.openaiChatgptAccountId) headers["chatgpt-account-id"] = this.config.openaiChatgptAccountId;

    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutController.abort(new DOMException("Upstream connection timed out", "TimeoutError"));
    }, this.config.upstreamConnectTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    try {
      return await this.fetchImpl(buildResponsesUrl(this.config.codexBaseUrl, this.config.codexResponsesPath), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };
  if (normalized.instructions == null) normalized.instructions = "";
  if (typeof normalized.input === "string") normalized.input = [{ role: "user", content: normalized.input }];
  return normalized;
}

function classifyStatus(status: number): UpstreamResult {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "rejected";
}

function statusError(status: number, result: UpstreamResult): HttpError {
  if (result === "rate_limited") return new HttpError(503, "upstream_rate_limited", "Codex upstream is rate limited");
  if (result === "auth") return new HttpError(502, "upstream_auth_error", "Codex upstream rejected OAuth credentials");
  if (result === "unavailable")
    return new HttpError(502, "upstream_unavailable", `Codex upstream failed with status ${status}`);
  return new HttpError(502, "upstream_rejected", `Codex upstream rejected the request with status ${status}`);
}
