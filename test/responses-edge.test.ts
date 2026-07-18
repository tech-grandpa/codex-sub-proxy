import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { HttpError } from "../src/http.js";
import { CodexResponsesForwarder } from "../src/responses.js";
import { TokenManager } from "../src/upstream.js";

function createForwarder(fetchImpl: typeof fetch, extraEnv: NodeJS.ProcessEnv = {}): CodexResponsesForwarder {
  const config = loadConfig({
    OPENAI_ACCESS_TOKEN: "access-token",
    OPENAI_EXPIRES_AT: "9999999999",
    ...extraEnv
  });
  return new CodexResponsesForwarder(config, new TokenManager(config), fetchImpl);
}

test("CodexResponsesForwarder rejects non-success upstream responses", async () => {
  const forwarder = createForwarder(async () => new Response("bad gateway", { status: 503 }));

  await assert.rejects(
    forwarder.forward({ model: "gpt-5.5", input: "hello" }),
    (error: unknown) => error instanceof HttpError
      && error.status === 502
      && error.code === "upstream_error"
      && error.message === "Codex upstream failed with status 503"
  );
});

test("CodexResponsesForwarder accepts JSON, empty, and non-JSON upstream bodies", async (context) => {
  await context.test("JSON", async () => {
    const forwarder = createForwarder(async () => new Response('{"id":"resp_json"}', { status: 200 }));
    assert.deepEqual(await forwarder.forward({ model: "gpt-5.5" }), { id: "resp_json" });
  });

  await context.test("empty", async () => {
    const forwarder = createForwarder(async () => new Response(null, { status: 200 }));
    assert.deepEqual(await forwarder.forward({ model: "gpt-5.5" }), {});
  });

  await context.test("non-JSON", async () => {
    const forwarder = createForwarder(async () => new Response("plain text", { status: 200 }));
    assert.deepEqual(await forwarder.forward({ model: "gpt-5.5" }), { raw: "plain text" });
  });
});

test("CodexResponsesForwarder parses delta-only SSE while ignoring malformed events", async () => {
  const forwarder = createForwarder(async () => new Response([
    "data: not-json",
    "",
    'data: {"delta":"hel"}',
    "",
    'data: {"type":"response.output_text.done","text":"hello"}',
    "",
    "data: [DONE]",
    "",
    ""
  ].join("\n"), { status: 200 }));

  assert.deepEqual(await forwarder.forward({ model: "gpt-5.5" }), {
    output_text: "hello",
    status: "completed"
  });
});

test("CodexResponsesForwarder sends account and authentication headers", async () => {
  let capturedHeaders: Record<string, string> | undefined;
  const forwarder = createForwarder(async (_input, init) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return new Response('{"status":"completed"}', { status: 200 });
  }, { OPENAI_CHATGPT_ACCOUNT_ID: "account-123" });

  await forwarder.forward({ model: "gpt-5.5", input: [] });

  assert.equal(capturedHeaders?.Authorization, "Bearer access-token");
  assert.equal(capturedHeaders?.["chatgpt-account-id"], "account-123");
  assert.equal(capturedHeaders?.originator, "codex-sub-proxy");
});
