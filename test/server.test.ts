import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/server.js";
import type { Config } from "../src/config.js";
import type { ResponsesForwarder } from "../src/responses.js";

const testConfig: Config = {
  host: "127.0.0.1",
  port: 0,
  proxyApiKey: "secret",
  codexBaseUrl: "https://chatgpt.com/backend-api/codex",
  codexResponsesPath: "/responses",
  codexModels: ["gpt-5.5"]
};

test("POST /v1/responses streams upstream SSE when stream is true", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      throw new Error("unexpected non-streaming forward");
    },
    async stream() {
      return new Response('event: response.output_text.delta\ndata: {"delta":"ok"}\n\n', { status: 200 });
    }
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true })
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
      return new Response([
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"hi"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"total_tokens":3}}}',
        "",
        ""
      ].join("\n"), { status: 200 });
    }
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      })
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
    }
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json"
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
              timezone: "Europe/London"
            }
          }
        },
        messages: [{ role: "user", content: "hello" }]
      })
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
        timezone: "Europe/London"
      }
    }
  ]);
  assert.equal(forwardedPayload?.tool_choice, "auto");
  assert.equal(forwardedPayload?.web_search_options, undefined);
});

test("file upload endpoints report an explicit unsupported response", async () => {
  const forwarder = unexpectedForwarder();

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/files`, {
      method: "POST",
      headers: { Authorization: "Bearer secret" }
    });

    assert.equal(response.status, 501);
    assert.deepEqual(await response.json(), {
      error: {
        type: "not_implemented",
        message: "/v1/files is not implemented; pass file content as Responses input_file parts instead"
      }
    });
  });
});

test("health check bypasses caller authentication", async () => {
  await withServer(unexpectedForwarder(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("models endpoint requires authentication and lists configured models", async () => {
  await withServer(unexpectedForwarder(), async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/v1/models`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), {
      error: { type: "unauthorized", message: "Missing or invalid bearer token" }
    });

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: "Bearer secret" }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      object: "list",
      data: [{ id: "gpt-5.5", object: "model", created: 0, owned_by: "openai" }]
    });
  });
});

test("non-streaming responses are forwarded with stream disabled", async () => {
  let forwardedPayload: Record<string, unknown> | undefined;
  const forwarder: ResponsesForwarder = {
    async forward(payload) {
      forwardedPayload = payload;
      return { id: "resp_1", output_text: "ok" };
    },
    async stream() {
      throw new Error("unexpected stream");
    }
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-5.5", input: "hello" })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "resp_1", output_text: "ok" });
  });

  assert.deepEqual(forwardedPayload, { model: "gpt-5.5", input: "hello", stream: false });
});

test("non-streaming chat completions translate the upstream response", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      return { output_text: "hello back", status: "incomplete", usage: { total_tokens: 4 } };
    },
    async stream() {
      throw new Error("unexpected stream");
    }
  };

  await withServer(forwarder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hello" }] })
    });

    assert.equal(response.status, 200);
    const body = await response.json() as {
      choices: Array<{
        message: { content: string };
        finish_reason: string;
      }>;
      usage: unknown;
    };
    assert.equal(body.choices[0]?.message.content, "hello back");
    assert.equal(body.choices[0]?.finish_reason, "length");
    assert.deepEqual(body.usage, { total_tokens: 4 });
  });
});

test("invalid JSON and unknown routes return OpenAI-shaped errors", async () => {
  await withServer(unexpectedForwarder(), async (baseUrl) => {
    const invalidJson = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json"
      },
      body: "not-json"
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), {
      error: { type: "invalid_json", message: "Request body must be valid JSON" }
    });

    const missing = await fetch(`${baseUrl}/missing`, {
      headers: { Authorization: "Bearer secret" }
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: { type: "not_found", message: "Route not found" }
    });
  });
});

function unexpectedForwarder(): ResponsesForwarder {
  return {
    async forward() {
      throw new Error("unexpected forward");
    },
    async stream() {
      throw new Error("unexpected stream");
    }
  };
}

async function withServer(forwarder: ResponsesForwarder, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(createApp({ config: testConfig, forwarder }));

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert(address && typeof address === "object");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
