export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_BASE_URL = "https://auth.openai.com";
export const USER_AGENT = "codex-sub-proxy/0.1";

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
    port: Number(env.PORT ?? 3000),
    proxyApiKey: emptyToUndefined(env.PROXY_API_KEY),
    openaiRefreshToken: emptyToUndefined(env.OPENAI_REFRESH_TOKEN),
    openaiAccessToken: emptyToUndefined(env.OPENAI_ACCESS_TOKEN),
    openaiExpiresAt: parseExpiresAt(env.OPENAI_EXPIRES_AT),
    openaiChatgptAccountId: emptyToUndefined(env.OPENAI_CHATGPT_ACCOUNT_ID),
    codexBaseUrl: env.CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex",
    codexResponsesPath: env.CODEX_RESPONSES_PATH ?? "/responses",
    codexModels: models.length > 0 ? models : ["gpt-5.5"]
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
