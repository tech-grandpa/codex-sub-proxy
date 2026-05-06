import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import { buildResponsesUrl, TokenManager } from "../src/upstream.js";

test("buildResponsesUrl combines configurable base URL and path cleanly", () => {
  assert.equal(
    buildResponsesUrl("https://chatgpt.com/backend-api/codex", "/v1/responses"),
    "https://chatgpt.com/backend-api/codex/v1/responses"
  );
  assert.equal(
    buildResponsesUrl("https://example.test/root/", "responses"),
    "https://example.test/root/responses"
  );
});

test("TokenManager refreshes access token with refresh-token OAuth shape", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const manager = new TokenManager(loadConfig({
    OPENAI_REFRESH_TOKEN: "old-refresh",
    CODEX_MODELS: "gpt-5.5"
  }), mockFetch);

  assert.equal(await manager.getAccessToken(), "new-access");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://auth.openai.com/oauth/token");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.ok(requests[0]?.init?.body instanceof URLSearchParams);

  const body = requests[0]?.init?.body as URLSearchParams;
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "old-refresh");
  assert.equal(body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");

  assert.equal(await manager.getAccessToken(), "new-access");
  assert.equal(requests.length, 1);
});
