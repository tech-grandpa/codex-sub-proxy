import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { CodexResponsesForwarder, type ResponsesForwarder } from "../src/responses.js";
import { createApp } from "../src/server.js";
import { TokenManager } from "../src/upstream.js";

const testConfig: Config = {
  host: "127.0.0.1",
  port: 0,
  proxyApiKey: "secret",
  codexBaseUrl: "https://chatgpt.com/backend-api/codex",
  codexResponsesPath: "/responses",
  codexModels: ["gpt-5.5"]
};

const chatRequest = {
  model: "gpt-5.5",
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: "user", content: "hello" }]
};

function sse(events: unknown[]): string {
  return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function streamingForwarder(body: Response["body"] | string): ResponsesForwarder {
  return {
    async forward() {
      throw new Error("unexpected non-streaming forward");
    },
    async stream() {
      return new Response(body, { status: 200 });
    }
  };
}

async function postChat(forwarder: ResponsesForwarder, request: Record<string, unknown> = chatRequest): Promise<Response> {
  const server = createServer(createApp({ config: testConfig, forwarder }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    // Read the body before the server closes.
    return new Response(await response.text(), { status: response.status, headers: response.headers });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function streamChunks(events: unknown[] | string, request?: Record<string, unknown>): Promise<unknown[]> {
  const response = await postChat(streamingForwarder(typeof events === "string" ? events : sse(events)), request);
  assert.equal(response.status, 200);
  return (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) => block.replace(/^data: /, ""))
    .map((data) => data === "[DONE]" ? data : JSON.parse(data));
}

function deltas(chunks: unknown[]): unknown[] {
  return chunks
    .filter((chunk): chunk is { choices: Array<{ delta: unknown }> } => typeof chunk === "object" && chunk !== null && "choices" in chunk)
    .flatMap((chunk) => chunk.choices.map((choice) => choice.delta));
}

function finishReason(chunks: unknown[]): unknown {
  const finals = chunks.flatMap((chunk) => (chunk as { choices?: Array<{ finish_reason: unknown }> }).choices ?? [])
    .map((choice) => choice.finish_reason)
    .filter((reason) => reason !== null);
  assert.equal(finals.length, 1);
  return finals[0];
}

test("chat streaming emits indexed tool_call deltas and chat-shaped usage", async () => {
  const chunks = await streamChunks([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "list_dir", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "{\"path\":" },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_2", delta: "{}" },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "\"a.txt\"}" },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" } },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "list_dir", arguments: "{}" } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }
  ]);

  assert.deepEqual(deltas(chunks), [
    { role: "assistant" },
    { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] },
    { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "list_dir", arguments: "" } }] },
    { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] },
    { tool_calls: [{ index: 1, function: { arguments: "{}" } }] },
    { tool_calls: [{ index: 0, function: { arguments: "\"a.txt\"}" } }] },
    {}
  ]);
  assert.equal(finishReason(chunks), "tool_calls");
  assert.deepEqual((chunks.at(-2) as Record<string, unknown>).usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  assert.deepEqual((chunks.at(-2) as Record<string, unknown>).choices, []);
  assert.equal(chunks.at(-1), "[DONE]");
});

test("chat streaming drops orphan argument deltas and recovers calls from output_item.done", async () => {
  const chunks = await streamChunks([
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "{\"lost\":" },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "list_dir" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"di" },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "list_dir", arguments: "{\"dir\":\".\"}" } },
    { type: "response.output_item.added", output_index: 2, item: { type: "message" } },
    { type: "response.completed", response: { status: "completed" } }
  ]);

  assert.deepEqual(deltas(chunks), [
    { role: "assistant" },
    { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] },
    { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "list_dir", arguments: "" } }] },
    { tool_calls: [{ index: 1, function: { arguments: "{\"di" } }] },
    { tool_calls: [{ index: 1, function: { arguments: "r\":\".\"}" } }] },
    {}
  ]);
  for (const delta of deltas(chunks)) {
    for (const call of (delta as { tool_calls?: Array<{ index: number }> }).tool_calls ?? []) {
      assert(call.index >= 0, "tool call index must never be negative");
    }
  }
});

test("chat streaming ignores output_item.done arguments that do not extend what was sent", async () => {
  const chunks = await streamChunks([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "f" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"a\":1}" },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "f", arguments: "{\"b\":2}" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "f" } },
    { type: "response.completed" }
  ]);

  assert.equal(deltas(chunks).length, 4);
  assert.equal(finishReason(chunks), "tool_calls");
});

test("chat streaming reports incomplete responses as length with usage", async () => {
  const chunks = await streamChunks([
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } } }
  ]);

  assert.equal(finishReason(chunks), "length");
  assert.deepEqual((chunks.at(-2) as Record<string, unknown>).usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  assert.equal(chunks.at(-1), "[DONE]");
});

test("chat streaming omits the usage chunk unless include_usage is requested", async () => {
  const events = [
    { type: "response.output_text.delta", delta: "hi" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1 } } }
  ];

  for (const request of [{ ...chatRequest, stream_options: undefined }, { ...chatRequest, stream_options: { include_usage: false } }]) {
    const chunks = await streamChunks(events, request);
    assert.equal(chunks.filter((chunk) => typeof chunk === "object" && chunk !== null && "usage" in chunk).length, 0);
    assert.equal(finishReason(chunks), "stop");
  }

  const noUsage = await streamChunks([{ type: "response.completed", response: { status: "completed" } }]);
  assert.equal(noUsage.filter((chunk) => typeof chunk === "object" && chunk !== null && "usage" in chunk).length, 0);
});

test("chat streaming surfaces upstream failures instead of a successful finish", async (context) => {
  const expectError = async (events: unknown[] | string, message: string): Promise<void> => {
    const chunks = await streamChunks(events);
    assert.deepEqual(chunks.at(-1), { error: { type: "upstream_error", message } });
    assert(!chunks.includes("[DONE]"), "a failed stream must not end with [DONE]");
    assert(!chunks.some((chunk) => (chunk as { choices?: Array<{ finish_reason: unknown }> }).choices?.some((choice) => choice.finish_reason !== null)));
  };

  await context.test("response.failed", () => expectError(
    [
      { type: "response.output_text.delta", delta: "par" },
      { type: "response.failed", response: { status: "failed", error: { message: "boom" } } },
      { type: "response.output_text.delta", delta: "ignored" }
    ],
    "Codex upstream response failed: boom"
  ));

  await context.test("response.failed without a response", () => expectError(
    [{ type: "response.failed" }],
    "Codex upstream response failed"
  ));

  await context.test("error event", () => expectError(
    [{ type: "error", message: "rate limited" }],
    "Codex upstream response failed: rate limited"
  ));

  await context.test("stream ends without a terminal event", () => expectError(
    [{ type: "response.output_text.delta", delta: "cut off" }],
    "Codex upstream stream ended before the response completed"
  ));

  await context.test("empty upstream body", async () => {
    const response = await postChat(streamingForwarder(null));
    const body = await response.text();
    assert.match(body, /Codex upstream stream ended before the response completed/);
  });

  await context.test("upstream body errors mid-stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse([{ type: "response.output_text.delta", delta: "hi" }])));
        controller.error(new Error("socket hang up"));
      }
    });
    const response = await postChat(streamingForwarder(body));
    assert.match(await response.text(), /"message":"Codex upstream stream was interrupted"/);
  });
});

test("chat streaming parses a trailing event without a final blank line", async () => {
  const body = sse([{ type: "response.output_text.delta", delta: "hi" }])
    + `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`;
  const chunks = await streamChunks(body);
  assert.equal(finishReason(chunks), "stop");
  assert.equal(chunks.at(-1), "[DONE]");
});

test("chat completions send only supported fields to the Codex backend", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const config = loadConfig({ OPENAI_ACCESS_TOKEN: "access-token", OPENAI_EXPIRES_AT: "9999999999" });
  const forwarder = new CodexResponsesForwarder(config, new TokenManager(config), async (_input, init) => {
    upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(sse([
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" } },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } }
    ]), { status: 200 });
  });

  const response = await postChat(forwarder, {
    model: "gpt-5.5",
    messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Read a file" }],
    reasoning_effort: "high",
    response_format: { type: "json_object" },
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "read_file" } },
    max_tokens: 128,
    temperature: 0.2,
    top_p: 1,
    metadata: { trace: "1" },
    store: true,
    stream_options: { include_usage: true }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamBody, {
    model: "gpt-5.5",
    instructions: "Be brief.",
    input: [{ role: "user", content: "Read a file" }],
    stream: true,
    store: false,
    reasoning: { effort: "high" },
    text: { format: { type: "json_object" } },
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "read_file" }
  });

  const completion = await response.json() as {
    choices: Array<{ message: Record<string, unknown>; finish_reason: string }>;
    usage: unknown;
  };
  assert.deepEqual(completion.choices[0]?.message, {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }]
  });
  assert.equal(completion.choices[0]?.finish_reason, "tool_calls");
  assert.deepEqual(completion.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
});
