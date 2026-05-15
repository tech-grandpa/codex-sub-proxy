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

test("file upload endpoints report an explicit unsupported response", async () => {
  const forwarder: ResponsesForwarder = {
    async forward() {
      throw new Error("unexpected forward");
    },
    async stream() {
      throw new Error("unexpected stream");
    }
  };

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
