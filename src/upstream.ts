import { AUTH_BASE_URL, CLIENT_ID, USER_AGENT, type Config } from "./config.js";
import { HttpError } from "./http.js";

interface TokenState {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
}

export class TokenManager {
  private state: TokenState;
  private refreshPromise?: Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Config, fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
    this.state = {
      accessToken: config.openaiAccessToken,
      refreshToken: config.openaiRefreshToken,
      expiresAt: config.openaiExpiresAt
    };
  }

  async getAccessToken(): Promise<string> {
    if (this.state.accessToken && !this.isExpiringSoon()) {
      return this.state.accessToken;
    }

    this.refreshPromise ??= this.refreshAccessToken().finally(() => {
      this.refreshPromise = undefined;
    });

    return this.refreshPromise;
  }

  private isExpiringSoon(): boolean {
    if (!this.state.expiresAt) return false;
    const now = Math.floor(Date.now() / 1000);
    return this.state.expiresAt - now <= 60;
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.state.refreshToken) {
      throw new HttpError(500, "missing_upstream_credentials", "OPENAI_REFRESH_TOKEN is required for upstream calls");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.state.refreshToken,
      client_id: CLIENT_ID
    });

    const response = await this.fetchImpl(`${AUTH_BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT
      },
      body
    });

    const data = (await safeJson(response)) as TokenResponse;
    if (!response.ok || !data.access_token) {
      throw new HttpError(
        502,
        "token_refresh_failed",
        `OpenAI token refresh failed with status ${response.status}`
      );
    }

    const now = Math.floor(Date.now() / 1000);
    this.state = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.state.refreshToken,
      expiresAt: data.expires_at ?? (data.expires_in ? now + data.expires_in : undefined)
    };

    return data.access_token;
  }
}

export function buildResponsesUrl(baseUrl: string, responsesPath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = responsesPath.startsWith("/") ? responsesPath.slice(1) : responsesPath;
  return new URL(normalizedPath, normalizedBase).toString();
}

export async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
