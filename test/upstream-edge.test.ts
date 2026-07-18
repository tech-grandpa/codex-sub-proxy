import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { HttpError } from "../src/http.js";
import { safeJson, TokenManager } from "../src/upstream.js";

test("TokenManager returns a non-expiring access token without refreshing", async () => {
  let fetchCalls = 0;
  const manager = new TokenManager(loadConfig({
    OPENAI_ACCESS_TOKEN: "cached-access"
  }), async () => {
    fetchCalls += 1;
    throw new Error("unexpected fetch");
  });

  assert.equal(await manager.getAccessToken(), "cached-access");
  assert.equal(fetchCalls, 0);
});

test("TokenManager reports missing refresh credentials", async () => {
  const manager = new TokenManager(loadConfig({}));

  await assert.rejects(
    manager.getAccessToken(),
    (error: unknown) => error instanceof HttpError
      && error.status === 500
      && error.code === "missing_upstream_credentials"
  );
});

test("TokenManager reports unsuccessful and malformed refresh responses", async (context) => {
  await context.test("unsuccessful response", async () => {
    const manager = new TokenManager(loadConfig({ OPENAI_REFRESH_TOKEN: "refresh" }), async () => (
      new Response('{"error":"invalid_grant"}', { status: 401 })
    ));

    await assert.rejects(
      manager.getAccessToken(),
      (error: unknown) => error instanceof HttpError
        && error.status === 502
        && error.code === "token_refresh_failed"
        && error.message === "OpenAI token refresh failed with status 401"
    );
  });

  await context.test("missing access token", async () => {
    const manager = new TokenManager(loadConfig({ OPENAI_REFRESH_TOKEN: "refresh" }), async () => (
      new Response('{"refresh_token":"new-refresh"}', { status: 200 })
    ));

    await assert.rejects(
      manager.getAccessToken(),
      (error: unknown) => error instanceof HttpError
        && error.code === "token_refresh_failed"
    );
  });
});

test("TokenManager coalesces simultaneous token refreshes", async () => {
  let fetchCalls = 0;
  let releaseResponse: (() => void) | undefined;
  const responseReady = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });

  const manager = new TokenManager(loadConfig({ OPENAI_REFRESH_TOKEN: "refresh" }), async () => {
    fetchCalls += 1;
    await responseReady;
    return new Response(JSON.stringify({ access_token: "new-access", expires_at: 9_999_999_999 }), {
      status: 200
    });
  });

  const first = manager.getAccessToken();
  const second = manager.getAccessToken();
  releaseResponse?.();

  assert.deepEqual(await Promise.all([first, second]), ["new-access", "new-access"]);
  assert.equal(fetchCalls, 1);
  assert.equal(await manager.getAccessToken(), "new-access");
  assert.equal(fetchCalls, 1);
});

test("safeJson handles empty, valid, and invalid response bodies", async () => {
  assert.deepEqual(await safeJson(new Response(null)), {});
  assert.deepEqual(await safeJson(new Response('{"ok":true}')), { ok: true });
  assert.deepEqual(await safeJson(new Response("plain text")), { raw: "plain text" });
});
