export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_BASE_URL = "https://auth.openai.com";
export const USER_AGENT = "codex-sub-proxy/0.2.0";

export interface Config {
  host: string;
  port: number;
  proxyApiKey?: string;
  openaiRefreshToken?: string;
  openaiAccessToken?: string;
  openaiExpiresAt?: number;
  openaiChatgptAccountId?: string;
  codexBaseUrl: string;
  codexResponsesPath: string;
  codexModels: string[];
  tokenFile?: string;
  upstreamConnectTimeoutMs: number;
  upstreamResponseTimeoutMs: number;
  upstreamIdleTimeoutMs: number;
  shutdownGraceMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxConcurrentStreams: number;
  maxConnections: number;
  maxRequestBytes: number;
}

export function parseExpiresAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed > 9_999_999_999 ? Math.floor(parsed / 1000) : Math.floor(parsed);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const models = (env.CODEX_MODELS ?? "gpt-5.5,gpt-5.5-pro,gpt-5.4,gpt-5.4-mini")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  return {
    host: env.HOST ?? "0.0.0.0",
    port: parsePort(env.PORT),
    proxyApiKey: emptyToUndefined(env.PROXY_API_KEY),
    openaiRefreshToken: emptyToUndefined(env.OPENAI_REFRESH_TOKEN),
    openaiAccessToken: emptyToUndefined(env.OPENAI_ACCESS_TOKEN),
    openaiExpiresAt: parseExpiresAt(env.OPENAI_EXPIRES_AT),
    openaiChatgptAccountId: emptyToUndefined(env.OPENAI_CHATGPT_ACCOUNT_ID),
    codexBaseUrl: env.CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex",
    codexResponsesPath: env.CODEX_RESPONSES_PATH ?? "/responses",
    codexModels: models.length > 0 ? models : ["gpt-5.5"],
    tokenFile: emptyToUndefined(env.OPENAI_TOKEN_FILE),
    upstreamConnectTimeoutMs: parsePositiveInteger(
      env.UPSTREAM_CONNECT_TIMEOUT_MS,
      10_000,
      "UPSTREAM_CONNECT_TIMEOUT_MS",
    ),
    upstreamResponseTimeoutMs: parsePositiveInteger(
      env.UPSTREAM_RESPONSE_TIMEOUT_MS,
      120_000,
      "UPSTREAM_RESPONSE_TIMEOUT_MS",
    ),
    upstreamIdleTimeoutMs: parsePositiveInteger(env.UPSTREAM_IDLE_TIMEOUT_MS, 30_000, "UPSTREAM_IDLE_TIMEOUT_MS"),
    shutdownGraceMs: parsePositiveInteger(env.SHUTDOWN_GRACE_MS, 30_000, "SHUTDOWN_GRACE_MS"),
    headersTimeoutMs: parsePositiveInteger(env.HEADERS_TIMEOUT_MS, 15_000, "HEADERS_TIMEOUT_MS"),
    requestTimeoutMs: parsePositiveInteger(env.REQUEST_TIMEOUT_MS, 30_000, "REQUEST_TIMEOUT_MS"),
    keepAliveTimeoutMs: parsePositiveInteger(env.KEEP_ALIVE_TIMEOUT_MS, 5_000, "KEEP_ALIVE_TIMEOUT_MS"),
    maxConcurrentStreams: parsePositiveInteger(env.MAX_CONCURRENT_STREAMS, 100, "MAX_CONCURRENT_STREAMS"),
    maxConnections: parsePositiveInteger(env.MAX_CONNECTIONS, 1_000, "MAX_CONNECTIONS"),
    maxRequestBytes: parsePositiveInteger(env.MAX_REQUEST_BYTES, 1_000_000, "MAX_REQUEST_BYTES"),
  };
}

function parsePort(value: string | undefined): number {
  if (value !== undefined && value.trim() === "") {
    throw new Error(`PORT must be an integer between 0 and 65535; received ${JSON.stringify(value)}`);
  }
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer between 0 and 65535; received ${JSON.stringify(value)}`);
  }
  return port;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(value)}`);
  }
  return parsed;
}
