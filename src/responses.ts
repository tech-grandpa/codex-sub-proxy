import { USER_AGENT, type Config } from "./config.js";
import { HttpError } from "./http.js";
import { stripUnsupportedParams } from "./strip.js";
import { buildResponsesUrl, safeJson, TokenManager } from "./upstream.js";

export interface ResponsesForwarder {
  forward(payload: Record<string, unknown>): Promise<unknown>;
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
    const accessToken = await this.tokenManager.getAccessToken();
    const body = stripUnsupportedParams(payload);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
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

    const data = await safeJson(response);
    if (!response.ok) {
      throw new HttpError(502, "upstream_error", `Codex upstream failed with status ${response.status}`);
    }

    return data;
  }
}
