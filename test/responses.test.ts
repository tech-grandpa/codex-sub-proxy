import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import { CodexResponsesForwarder } from "../src/responses.js";
import { TokenManager } from "../src/upstream.js";

test("CodexResponsesForwarder adapts non-streaming requests to upstream SSE responses", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const tokenManager = new TokenManager(loadConfig({
    OPENAI_ACCESS_TOKEN: "access-token",
    OPENAI_EXPIRES_AT: "9999999999",
    CODEX_RESPONSES_PATH: "/responses"
  }));

  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response([
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}',
      "",
      ""
    ].join("\n"), { status: 200 });
  };

  const forwarder = new CodexResponsesForwarder(
    loadConfig({
      OPENAI_ACCESS_TOKEN: "access-token",
      OPENAI_EXPIRES_AT: "9999999999",
      CODEX_RESPONSES_PATH: "/responses"
    }),
    tokenManager,
    mockFetch
  );

  const response = await forwarder.forward({
    model: "gpt-5.5",
    input: "hello",
    stream: false
  });

  assert.deepEqual(response, {
    id: "resp_1",
    status: "completed",
    output: [],
    output_text: "ok"
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).Accept, "text/event-stream");

  const body = JSON.parse(String(requests[0]?.init?.body));
  assert.deepEqual(body.input, [{ role: "user", content: "hello" }]);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
});
