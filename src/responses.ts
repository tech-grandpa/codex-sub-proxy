import { USER_AGENT, type Config } from "./config.js";
import { HttpError } from "./http.js";
import { stripUnsupportedParams } from "./strip.js";
import { buildResponsesUrl, TokenManager } from "./upstream.js";

export interface ResponsesForwarder {
  forward(payload: Record<string, unknown>): Promise<unknown>;
  stream(payload: Record<string, unknown>): Promise<Response>;
}

export class CodexResponsesForwarder implements ResponsesForwarder {
  private readonly config: Config;
  private readonly tokenManager: TokenManager;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Config, tokenManager: TokenManager, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.tokenManager = tokenManager;
    this.fetchImpl = fetchImpl;
  }

  async forward(payload: Record<string, unknown>): Promise<unknown> {
    const response = await this.stream(payload);
    return readUpstreamResponse(response);
  }

  async stream(payload: Record<string, unknown>): Promise<Response> {
    const accessToken = await this.tokenManager.getAccessToken();
    const body = {
      ...normalizeResponsesPayload(stripUnsupportedParams(payload)),
      store: false,
      stream: true
    };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      originator: "codex-sub-proxy"
    };

    if (this.config.openaiChatgptAccountId) {
      headers["chatgpt-account-id"] = this.config.openaiChatgptAccountId;
    }

    const response = await this.fetchImpl(buildResponsesUrl(this.config.codexBaseUrl, this.config.codexResponsesPath), {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new HttpError(502, "upstream_error", `Codex upstream failed with status ${response.status}`);
    }

    return response;
  }
}

function normalizeResponsesPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };

  if (normalized.instructions == null) {
    normalized.instructions = "";
  }

  if (typeof normalized.input === "string") {
    normalized.input = [{ role: "user", content: normalized.input }];
  }

  return normalized;
}

async function readUpstreamResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};

  const trimmed = text.trimStart();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    return parseResponsesSse(text);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function parseResponsesSse(text: string): unknown {
  let completedResponse: Record<string, unknown> | undefined;
  let outputText = "";

  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) continue;

    const rawData = dataLines.join("\n");
    if (rawData === "[DONE]") continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof event.delta === "string") {
      outputText += event.delta;
    }

    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      outputText = event.text;
    }

    if (event.type === "response.completed" && event.response && typeof event.response === "object") {
      completedResponse = event.response as Record<string, unknown>;
    }
  }

  if (completedResponse) {
    return outputText ? { ...completedResponse, output_text: outputText } : completedResponse;
  }

  return outputText ? { output_text: outputText, status: "completed" } : {};
}
