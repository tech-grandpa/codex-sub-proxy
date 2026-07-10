import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { CodexResponsesForwarder } from "../src/responses.js";
import { TokenManager } from "../src/upstream.js";

test("CodexResponsesForwarder adapts non-streaming requests to upstream SSE responses", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const tokenManager = new TokenManager(
    loadConfig({
      OPENAI_ACCESS_TOKEN: "access-token",
      OPENAI_EXPIRES_AT: "9999999999",
      CODEX_RESPONSES_PATH: "/responses",
    }),
  );

  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(
      [
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}',
        "",
        "",
      ].join("\n"),
      { status: 200 },
    );
  };

  const forwarder = new CodexResponsesForwarder(
    loadConfig({
      OPENAI_ACCESS_TOKEN: "access-token",
      OPENAI_EXPIRES_AT: "9999999999",
      CODEX_RESPONSES_PATH: "/responses",
    }),
    tokenManager,
    mockFetch,
  );

  const response = await forwarder.forward({
    model: "gpt-5.5",
    input: "hello",
    stream: false,
  });

  assert.deepEqual(response, {
    id: "resp_1",
    status: "completed",
    output: [],
    output_text: "ok",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
  const headers = requests[0]?.init?.headers;
  assert.ok(headers && !Array.isArray(headers) && !(headers instanceof Headers));
  assert.equal((headers as Record<string, string>).Accept, "text/event-stream");

  const body = JSON.parse(String(requests[0]?.init?.body));
  assert.equal(body.instructions, "");
  assert.deepEqual(body.input, [{ role: "user", content: "hello" }]);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
});

test("CodexResponsesForwarder exposes upstream SSE for streaming callers", async () => {
  const tokenManager = new TokenManager(
    loadConfig({
      OPENAI_ACCESS_TOKEN: "access-token",
      OPENAI_EXPIRES_AT: "9999999999",
      CODEX_RESPONSES_PATH: "/responses",
    }),
  );

  const mockFetch: typeof fetch = async () =>
    new Response("event: response.output_text.delta\ndata: {}\n\n", {
      status: 200,
    });

  const forwarder = new CodexResponsesForwarder(
    loadConfig({
      OPENAI_ACCESS_TOKEN: "access-token",
      OPENAI_EXPIRES_AT: "9999999999",
      CODEX_RESPONSES_PATH: "/responses",
    }),
    tokenManager,
    mockFetch,
  );

  const response = await forwarder.stream({
    model: "gpt-5.5",
    input: [{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }],
    stream: true,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "event: response.output_text.delta\ndata: {}\n\n");
});

test("CodexResponsesForwarder refreshes once and retries after upstream rejects a token", async () => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    requests.push({ url, authorization: headers?.Authorization });
    if (url.endsWith("/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
        {
          status: 200,
        },
      );
    }
    if (headers?.Authorization === "Bearer old-access") return new Response("unauthorized", { status: 401 });
    return new Response("data: [DONE]\n\n", { status: 200 });
  };
  const config = loadConfig({
    OPENAI_ACCESS_TOKEN: "old-access",
    OPENAI_REFRESH_TOKEN: "refresh",
    OPENAI_EXPIRES_AT: "9999999999",
  });
  const manager = new TokenManager(config, mockFetch);
  const forwarder = new CodexResponsesForwarder(config, manager, mockFetch);

  assert.equal((await forwarder.stream({ model: "gpt-5.5", input: "hello" })).status, 200);
  assert.deepEqual(
    requests.map(({ url, authorization }) => [url.endsWith("/oauth/token") ? "oauth" : "codex", authorization]),
    [
      ["codex", "Bearer old-access"],
      ["oauth", undefined],
      ["codex", "Bearer new-access"],
    ],
  );
});

test("CodexResponsesForwarder propagates caller cancellation to fetch", async () => {
  const config = loadConfig({ OPENAI_ACCESS_TOKEN: "access", OPENAI_EXPIRES_AT: "9999999999" });
  let receivedSignal: AbortSignal | undefined;
  const mockFetch: typeof fetch = async (_input, init) => {
    receivedSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      if (receivedSignal?.aborted) {
        reject(receivedSignal.reason);
        return;
      }
      receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), { once: true });
    });
  };
  const manager = new TokenManager(config, mockFetch);
  const forwarder = new CodexResponsesForwarder(config, manager, mockFetch);
  const controller = new AbortController();
  const pending = forwarder.stream({ model: "gpt-5.5", input: "hello" }, { signal: controller.signal });
  controller.abort(new Error("caller left"));
  await assert.rejects(pending, /caller left/);
  assert.equal(receivedSignal?.aborted, true);
});

test("CodexResponsesForwarder enforces connect and complete-response deadlines", async () => {
  const keepEventLoopAlive = setInterval(() => {}, 1_000);
  const connectConfig = loadConfig({
    OPENAI_ACCESS_TOKEN: "access",
    OPENAI_EXPIRES_AT: "9999999999",
    UPSTREAM_CONNECT_TIMEOUT_MS: "10",
  });
  const hangingFetch: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const connectForwarder = new CodexResponsesForwarder(
    connectConfig,
    new TokenManager(connectConfig, hangingFetch),
    hangingFetch,
  );
  await assert.rejects(connectForwarder.stream({ model: "gpt-5.5", input: "hello" }), { name: "TimeoutError" });

  const responseConfig = loadConfig({
    OPENAI_ACCESS_TOKEN: "access",
    OPENAI_EXPIRES_AT: "9999999999",
    UPSTREAM_RESPONSE_TIMEOUT_MS: "10",
  });
  const headersOnlyFetch: typeof fetch = async () => new Response(new ReadableStream({}));
  const responseForwarder = new CodexResponsesForwarder(
    responseConfig,
    new TokenManager(responseConfig, headersOnlyFetch),
    headersOnlyFetch,
  );
  try {
    await assert.rejects(responseForwarder.forward({ model: "gpt-5.5", input: "hello" }), { name: "TimeoutError" });
  } finally {
    clearInterval(keepEventLoopAlive);
  }
});

test("connect deadline is cleared after headers and does not abort a healthy stream", async () => {
  const config = loadConfig({
    OPENAI_ACCESS_TOKEN: "access",
    OPENAI_EXPIRES_AT: "9999999999",
    UPSTREAM_CONNECT_TIMEOUT_MS: "10",
  });
  let receivedSignal: AbortSignal | undefined;
  const mockFetch: typeof fetch = async (_input, init) => {
    receivedSignal = init?.signal ?? undefined;
    return new Response("data: [DONE]\n\n");
  };
  const forwarder = new CodexResponsesForwarder(config, new TokenManager(config, mockFetch), mockFetch);
  const response = await forwarder.stream({ model: "gpt-5.5", input: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(receivedSignal?.aborted, false);
  assert.equal(await response.text(), "data: [DONE]\n\n");
});

test("non-streaming forwarding rejects malformed JSON success bodies", async () => {
  const config = loadConfig({ OPENAI_ACCESS_TOKEN: "access", OPENAI_EXPIRES_AT: "9999999999" });
  const mockFetch: typeof fetch = async () => new Response("not-json", { status: 200 });
  const forwarder = new CodexResponsesForwarder(config, new TokenManager(config, mockFetch), mockFetch);
  await assert.rejects(forwarder.forward({ model: "gpt-5.5", input: "hello" }), /malformed response JSON/);
});
