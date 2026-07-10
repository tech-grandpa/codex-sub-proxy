import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { type Config, loadConfig } from "../src/config.js";
import type { ResponsesForwarder } from "../src/responses.js";
import { createApp } from "../src/server.js";

const testConfig: Config = {
  ...loadConfig({}),
  host: "127.0.0.1",
  port: 0,
  proxyApiKey: "secret",
  codexBaseUrl: "https://chatgpt.com/backend-api/codex",
  codexResponsesPath: "/responses",
  codexModels: ["gpt-5.5"],
};

test("POST /v1/responses streams upstream SSE when stream is true", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      throw new Error("unexpected non-streaming forward");
    },
    async stream() {
      return new Response('event: response.output_text.delta\ndata: {"delta":"ok"}\n\n', { status: 200 });
    },
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), 'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n');
  });
});

test("POST /v1/chat/completions translates upstream SSE into chat chunks", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      throw new Error("unexpected non-streaming forward");
    },
    async stream() {
      return new Response(
        [
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"hi"}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"usage":{"total_tokens":3}}}',
          "",
          "",
        ].join("\n"),
        { status: 200 },
      );
    },
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");

    const body = await response.text();
    assert.match(body, /"object":"chat.completion.chunk"/);
    assert.match(body, /"delta":\{"role":"assistant"\}/);
    assert.match(body, /"delta":\{"content":"hi"\}/);
    assert.match(body, /"finish_reason":"stop"/);
    assert.match(body, /data: \[DONE\]/);
  });
});

test("POST /v1/chat/completions maps web_search_options before forwarding", async () => {
  let forwardedPayload: Record<string, unknown> | undefined;
  const forwarder: ResponsesForwarder = {
    async forward(payload) {
      forwardedPayload = payload;
      return { output_text: "ok" };
    },
    async stream() {
      throw new Error("unexpected stream");
    },
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        web_search_options: {
          search_context_size: "low",
          user_location: {
            type: "approximate",
            approximate: {
              country: "GB",
              city: "London",
              region: "London",
              timezone: "Europe/London",
            },
          },
        },
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(forwardedPayload?.tools, [
    {
      type: "web_search",
      search_context_size: "low",
      user_location: {
        type: "approximate",
        country: "GB",
        city: "London",
        region: "London",
        timezone: "Europe/London",
      },
    },
  ]);
  assert.equal(forwardedPayload?.tool_choice, "auto");
  assert.equal(forwardedPayload?.web_search_options, undefined);
});

test("file upload endpoints report an explicit unsupported response", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      throw new Error("unexpected forward");
    },
    async stream() {
      throw new Error("unexpected stream");
    },
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/files`, {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    });

    assert.equal(response.status, 501);
    assert.deepEqual(await response.json(), {
      error: {
        type: "not_implemented",
        message: "/v1/files is not implemented; pass file content as Responses input_file parts instead",
      },
    });
  });
});

test("request schemas and configured body limits reject invalid payloads before forwarding", async () => {
  let forwards = 0;
  const forwarder: ResponsesForwarder = {
    async forward() {
      forwards += 1;
      return {};
    },
    async stream() {
      forwards += 1;
      return new Response();
    },
  };
  await withServer(
    forwarder,
    async (baseUrl) => {
      for (const body of [
        { model: "gpt-5.5" },
        { input: "hello" },
        { model: "gpt-5.5", input: "hello", stream: "yes" },
      ]) {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
      }
      const oversized = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "x".repeat(200) }),
      });
      assert.equal(oversized.status, 413);
      assert.equal(forwards, 0);
    },
    { ...testConfig, maxRequestBytes: 100 },
  );
});

test("streaming failures close the response after headers have been sent", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      throw new Error("unexpected forward");
    },
    async stream() {
      let readCount = 0;
      return new Response(
        new ReadableStream({
          async pull(controller) {
            if (readCount++ === 0) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            } else {
              await new Promise((resolve) => setTimeout(resolve, 10));
              controller.error(new Error("upstream stream failed"));
            }
          },
        }),
      );
    },
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
    });

    await assert.rejects(response.text());
  });
});

test("requests receive correlation IDs and authenticated metrics", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      return { output_text: "ok" };
    },
    async stream() {
      throw new Error("unexpected stream");
    },
  };
  await withServer(forwarder, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`, { headers: { "X-Request-Id": "caller-request-1" } });
    assert.equal(health.headers.get("x-request-id"), "caller-request-1");

    const unauthorized = await fetch(`${baseUrl}/metrics`);
    assert.equal(unauthorized.status, 401);
    const metrics = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: "Bearer secret" } });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /codex_proxy_http_requests_total/);
  });
});

test("streaming chat maps function calls, refusal, annotations, non-text output, and usage", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      throw new Error("unexpected forward");
    },
    async stream() {
      return new Response(
        [
          'data: {"type":"response.refusal.delta","delta":"no"}',
          "",
          'data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.test"}}',
          "",
          'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":""}}',
          "",
          'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"id\\":1}"}',
          "",
          'data: {"type":"response.output_item.added","output_index":2,"item":{"type":"image_generation_call","id":"image_1"}}',
          "",
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
          "",
          "",
        ].join("\n"),
      );
    },
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await response.text();
    assert.match(body, /"refusal":"no"/);
    assert.match(body, /"annotations":\[\{"type":"url_citation"/);
    assert.match(body, /"tool_calls":\[\{"index":0,"id":"call_1"/);
    assert.match(body, /"arguments":"\{\\"id\\":1\}"/);
    assert.match(body, /"response_output":\[\{"type":"image_generation_call"/);
    assert.match(body, /"finish_reason":"tool_calls"/);
    assert.match(body, /"choices":\[\],"usage":\{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5\}/);
  });
});

test("stream idle deadlines terminate stalled upstream bodies", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      throw new Error("unexpected forward");
    },
    async stream() {
      return new Response(new ReadableStream({}));
    },
  };

  await withServer(
    forwarder,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
      });
      await assert.rejects(response.text());
    },
    { ...testConfig, upstreamIdleTimeoutMs: 10 },
  );
});

test("concurrent stream limits reject excess streams and caller disconnect aborts forwarding", async () => {
  let forwardedSignal: AbortSignal | undefined;
  const forwarder: ResponsesForwarder = {
    async forward() {
      throw new Error("unexpected forward");
    },
    async stream(_payload, options) {
      forwardedSignal = options?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          },
        }),
      );
    },
  };

  await withServer(
    forwarder,
    async (baseUrl) => {
      const controller = new AbortController();
      const first = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
        signal: controller.signal,
      });
      const second = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
      });
      assert.equal(second.status, 429);
      controller.abort();
      await assert.rejects(first.text());
      await waitFor(() => forwardedSignal?.aborted === true);
      assert.equal(forwardedSignal?.aborted, true);
    },
    { ...testConfig, maxConcurrentStreams: 1 },
  );
});

async function withServer(
  forwarder: ResponsesForwarder,
  run: (baseUrl: string) => Promise<void>,
  config: Config = testConfig,
): Promise<void> {
  const server = createServer(createApp({ config, forwarder }));

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert(address && typeof address === "object");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
