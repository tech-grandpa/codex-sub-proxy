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

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("CodexResponsesForwarder keeps function-call arguments out of output_text", async () => {
  const functionCall = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" };
  const forwarder = createForwarder(async () => new Response(sse([
    { type: "response.output_item.added", output_index: 0, item: { ...functionCall, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "{\"path\":" },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "\"a.txt\"}" },
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.output_item.done", output_index: 0, item: functionCall },
    { type: "response.output_item.done", output_index: 1, item: "malformed" },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }
  ]), { status: 200 }));

  assert.deepEqual(await forwarder.forward({ model: "gpt-5.5" }), {
    id: "resp_1",
    status: "completed",
    output: [functionCall]
  });
});

test("CodexResponsesForwarder keeps output items from the terminal event when present", async () => {
  const message = { type: "message", content: [{ type: "output_text", text: "hi" }] };
  const forwarder = createForwarder(async () => new Response(sse([
    { type: "response.output_text.delta", delta: "hi" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [] } },
    { type: "response.completed", response: { status: "completed", output: [message] } }
  ]), { status: 200 }));

  assert.deepEqual(await forwarder.forward({ model: "gpt-5.5" }), {
    status: "completed",
    output: [message],
    output_text: "hi"
  });
});

test("CodexResponsesForwarder returns incomplete responses with their status", async () => {
  const forwarder = createForwarder(async () => new Response(sse([
    { type: "response.output_text.delta", delta: "part" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }
  ]), { status: 200 }));

  assert.deepEqual(await forwarder.forward({ model: "gpt-5.5" }), {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output_text: "part"
  });
});

test("CodexResponsesForwarder turns failed responses and error events into upstream errors", async (context) => {
  const expectFailure = async (events: unknown[], message: string): Promise<void> => {
    const forwarder = createForwarder(async () => new Response(sse(events), { status: 200 }));
    await assert.rejects(
      forwarder.forward({ model: "gpt-5.5" }),
      (error: unknown) => error instanceof HttpError
        && error.status === 502
        && error.code === "upstream_error"
        && error.message === message
    );
  };

  await context.test("response.failed", () => expectFailure(
    [{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } }],
    "Codex upstream response failed: boom"
  ));

  await context.test("response.failed without details", () => expectFailure(
    [{ type: "response.failed", response: { status: "failed" } }],
    "Codex upstream response failed"
  ));

  await context.test("error event", () => expectFailure(
    [{ type: "error", code: "rate_limit_exceeded", message: "slow down" }],
    "Codex upstream response failed: slow down"
  ));
});
