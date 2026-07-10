import { AUTH_BASE_URL, CLIENT_ID, type Config, parseExpiresAt, USER_AGENT } from "./config.js";
import { HttpError } from "./http.js";
import { FileTokenStore, MemoryTokenStore, type TokenState, type TokenStore } from "./token-store.js";

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
  private readonly store: TokenStore;
  private readonly connectTimeoutMs: number;

  constructor(config: Config, fetchImpl: typeof fetch = fetch, store?: TokenStore) {
    this.fetchImpl = fetchImpl;
    this.state = {
      accessToken: config.openaiAccessToken,
      refreshToken: config.openaiRefreshToken,
      expiresAt: config.openaiExpiresAt,
    };
    this.store =
      store ??
      (config.tokenFile
        ? new FileTokenStore(config.tokenFile, this.state, {
            lockTimeoutMs: Math.max(15_000, config.upstreamConnectTimeoutMs + 5_000),
            staleLockMs: Math.max(30_000, config.upstreamConnectTimeoutMs * 2),
          })
        : new MemoryTokenStore(this.state));
    this.connectTimeoutMs = config.upstreamConnectTimeoutMs;
  }

  async getAccessToken(): Promise<string> {
    this.refreshPromise ??= this.store
      .withRefreshLock(async () => {
        this.state = { ...this.state, ...(await this.store.load()) };
        if (this.isUsable()) return this.state.accessToken as string;
        return this.refreshAccessToken();
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }

  async invalidateAccessToken(rejectedToken: string): Promise<void> {
    await this.store.withRefreshLock(async () => {
      this.state = { ...this.state, ...(await this.store.load()) };
      if (this.state.accessToken !== rejectedToken) return;
      this.state.accessToken = undefined;
      this.state.expiresAt = undefined;
      await this.store.save(this.state);
    });
  }

  private isUsable(): boolean {
    if (!this.state.accessToken) return false;
    if (!this.state.expiresAt) return !this.state.refreshToken;
    const now = Math.floor(Date.now() / 1000);
    return this.state.expiresAt - now > 60;
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.state.refreshToken) {
      throw new HttpError(500, "missing_upstream_credentials", "OPENAI_REFRESH_TOKEN is required for upstream calls");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.state.refreshToken,
      client_id: CLIENT_ID,
    });

    const response = await this.fetchImpl(`${AUTH_BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(this.connectTimeoutMs),
    });

    const data = (await safeJson(response)) as TokenResponse;
    if (!response.ok || !data.access_token) {
      throw new HttpError(502, "token_refresh_failed", `OpenAI token refresh failed with status ${response.status}`);
    }

    const now = Math.floor(Date.now() / 1000);
    this.state = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.state.refreshToken,
      expiresAt:
        data.expires_at !== undefined
          ? parseExpiresAt(String(data.expires_at))
          : data.expires_in
            ? now + data.expires_in
            : undefined,
    };
    await this.store.save(this.state);

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
