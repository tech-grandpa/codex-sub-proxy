import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig, parseExpiresAt } from "../src/config.js";

test("parseExpiresAt accepts seconds and milliseconds and rejects invalid values", () => {
  assert.equal(parseExpiresAt("1778799721"), 1_778_799_721);
  assert.equal(parseExpiresAt("1778799721000"), 1_778_799_721);
  assert.equal(parseExpiresAt("12.9"), 12);

  for (const invalid of [undefined, "", "nope", "0", "-1", "Infinity"]) {
    assert.equal(parseExpiresAt(invalid), undefined);
  }
});

test("loadConfig applies defaults and trims optional credentials", () => {
  const config = loadConfig({
    PROXY_API_KEY: "  proxy-secret  ",
    OPENAI_REFRESH_TOKEN: "   ",
    OPENAI_ACCESS_TOKEN: " access-token ",
    CODEX_MODELS: " gpt-5.5, ,gpt-5.4-mini "
  });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 3000);
  assert.equal(config.proxyApiKey, "proxy-secret");
  assert.equal(config.openaiRefreshToken, undefined);
  assert.equal(config.openaiAccessToken, "access-token");
  assert.deepEqual(config.codexModels, ["gpt-5.5", "gpt-5.4-mini"]);
});

test("loadConfig falls back to a model when CODEX_MODELS contains only whitespace", () => {
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "8080",
    CODEX_MODELS: " , ",
    CODEX_BASE_URL: "https://example.test/codex",
    CODEX_RESPONSES_PATH: "v1/responses"
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8080);
  assert.deepEqual(config.codexModels, ["gpt-5.5"]);
  assert.equal(config.codexBaseUrl, "https://example.test/codex");
  assert.equal(config.codexResponsesPath, "v1/responses");
});
