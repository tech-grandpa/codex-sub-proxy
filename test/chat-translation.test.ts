import assert from "node:assert/strict";
import test from "node:test";

import { chatToResponsesPayload, extractOutputText, responsesToChatCompletion, toChatUsage } from "../src/chat.js";
import { HttpError } from "../src/http.js";

const base = { model: "gpt-5.5", messages: [{ role: "user", content: "Hi" }] };

function assertInvalidRequest(run: () => unknown, message: string): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof HttpError
      && error.status === 400
      && error.code === "invalid_request"
      && error.message === message
  );
}

function firstChoice(completion: Record<string, unknown>): Record<string, unknown> {
  return (completion.choices as Array<Record<string, unknown>>)[0] ?? {};
}

test("chatToResponsesPayload maps response_format and verbosity into Responses text options", () => {
  const schema = chatToResponsesPayload({
    ...base,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        description: "The answer",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        strict: true
      }
    },
    verbosity: "low"
  });
  assert.deepEqual(schema.text, {
    format: {
      type: "json_schema",
      name: "answer",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
      description: "The answer",
      strict: true
    },
    verbosity: "low"
  });
  assert.equal(schema.response_format, undefined);
  assert.equal(schema.verbosity, undefined);

  const minimalSchema = chatToResponsesPayload({ ...base, response_format: { type: "json_schema", json_schema: { name: "answer" } } });
  assert.deepEqual(minimalSchema.text, { format: { type: "json_schema", name: "answer" } });

  const jsonObject = chatToResponsesPayload({ ...base, response_format: { type: "json_object" } });
  assert.deepEqual(jsonObject.text, { format: { type: "json_object" } });

  const merged = chatToResponsesPayload({ ...base, text: { verbosity: "high" }, response_format: { type: "text" } });
  assert.deepEqual(merged.text, { verbosity: "high", format: { type: "text" } });

  assert.equal(chatToResponsesPayload(base).text, undefined);
});

test("chatToResponsesPayload rejects malformed text options", () => {
  assertInvalidRequest(() => chatToResponsesPayload({ ...base, text: "json" }), "text must be an object");
  assertInvalidRequest(() => chatToResponsesPayload({ ...base, response_format: "json" }), "response_format must be an object");
  assertInvalidRequest(
    () => chatToResponsesPayload({ ...base, response_format: { type: "json_schema", json_schema: {} } }),
    "response_format.json_schema.name is required"
  );
  assertInvalidRequest(
    () => chatToResponsesPayload({ ...base, response_format: { type: "yaml" } }),
    "Unsupported response_format type: yaml"
  );
  assertInvalidRequest(() => chatToResponsesPayload({ ...base, verbosity: 1 }), "verbosity must be a string");
});

test("chatToResponsesPayload accepts alternate assistant tool_call shapes", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { call_id: "call_a", name: "flat", arguments: "{}" },
          { id: "call_b", type: "function", function: { name: "nested" } }
        ]
      }
    ]
  });

  assert.deepEqual(payload.input, [
    { type: "function_call", call_id: "call_a", name: "flat", arguments: "{}" },
    { type: "function_call", call_id: "call_b", name: "nested", arguments: "{}" }
  ]);
});

test("chatToResponsesPayload validates assistant tool_calls", () => {
  const withToolCalls = (toolCalls: unknown) => () => chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "assistant", content: null, tool_calls: toolCalls }]
  });

  assertInvalidRequest(withToolCalls("call"), "assistant message tool_calls must be an array");
  assertInvalidRequest(withToolCalls([null]), "tool_calls[0] must be an object");
  assertInvalidRequest(withToolCalls([{ function: { name: "f" } }]), "tool_calls[0].id is required");
  assertInvalidRequest(withToolCalls([{ id: "call_1", function: "f" }]), "tool_calls[0].function.name is required");
});

test("chatToResponsesPayload flattens structured tool message content", () => {
  const toolMessage = (content: unknown) => chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "tool", tool_call_id: "call_1", content }]
  }).input[0];

  assert.deepEqual(toolMessage(["line one", { type: "text", text: "line two" }, { type: "image" }]), {
    type: "function_call_output",
    call_id: "call_1",
    output: "line one\nline two"
  });
  assert.deepEqual(toolMessage(null), { type: "function_call_output", call_id: "call_1", output: "" });
  assert.deepEqual(toolMessage(42), { type: "function_call_output", call_id: "call_1", output: "42" });
});

test("chatToResponsesPayload passes Responses-native tools through", () => {
  const tools = [
    { type: "function", name: "flat", parameters: { type: "object" } },
    { type: "web_search" }
  ];
  assert.deepEqual(chatToResponsesPayload({ ...base, tools }).tools, tools);

  assert.deepEqual(
    chatToResponsesPayload({ ...base, tools: [{ type: "function", function: { name: "bare" } }] }).tools,
    [{ type: "function", name: "bare" }]
  );
});

test("chatToResponsesPayload validates chat tool definitions", () => {
  assertInvalidRequest(() => chatToResponsesPayload({ ...base, tools: {} }), "tools must be an array");
  assertInvalidRequest(() => chatToResponsesPayload({ ...base, tools: ["read_file"] }), "tools[0] must be an object");
  assertInvalidRequest(
    () => chatToResponsesPayload({ ...base, tools: [{ type: "function", function: { description: "no name" } }] }),
    "tools[0].function.name is required"
  );
  assertInvalidRequest(
    () => chatToResponsesPayload({ ...base, tools: [{ type: "function" }] }),
    "tools[0] is not a supported tool definition"
  );
});

test("chatToResponsesPayload keeps tool_choice values it cannot translate", () => {
  const responsesShaped = { type: "function", name: "read_file" };
  assert.deepEqual(chatToResponsesPayload({ ...base, tool_choice: responsesShaped }).tool_choice, responsesShaped);

  const nameless = { type: "function", function: {} };
  assert.deepEqual(chatToResponsesPayload({ ...base, tool_choice: nameless }).tool_choice, nameless);

  assert.equal(chatToResponsesPayload({ ...base, tool_choice: 7 }).tool_choice, 7);
});

test("responsesToChatCompletion ignores reasoning text and normalizes tool calls", () => {
  const completion = responsesToChatCompletion({
    output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking..." }] },
      { type: "message", content: [{ type: "refusal", refusal: "no" }, { type: "output_text", text: "Done." }] },
      { type: "function_call", id: "fc_1", name: "a", arguments: { path: "x" } },
      { type: "function_call", arguments: undefined }
    ]
  }, "gpt-5.5");

  const choice = firstChoice(completion);
  const message = choice.message as { content: string; tool_calls: Array<{ id: string; function: Record<string, unknown> }> };
  assert.equal(message.content, "Done.");
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(message.tool_calls[0]?.id, "fc_1");
  assert.deepEqual(message.tool_calls[0]?.function, { name: "a", arguments: "{\"path\":\"x\"}" });
  assert.match(message.tool_calls[1]?.id ?? "", /^call_[0-9a-f]{32}$/);
  assert.deepEqual(message.tool_calls[1]?.function, { name: "", arguments: "{}" });
});

test("responsesToChatCompletion returns null content for tool-call-only turns", () => {
  const completion = responsesToChatCompletion({
    output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" }]
  }, "gpt-5.5");

  assert.equal((firstChoice(completion).message as Record<string, unknown>).content, null);
});

test("responsesToChatCompletion reports truncation ahead of tool calls", () => {
  const truncatedCall = responsesToChatCompletion({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"pa" }]
  }, "gpt-5.5");
  assert.equal(firstChoice(truncatedCall).finish_reason, "length");

  const filtered = responsesToChatCompletion({
    status: "incomplete",
    incomplete_details: { reason: "content_filter" },
    output_text: "partial"
  }, "gpt-5.5");
  assert.equal(firstChoice(filtered).finish_reason, "content_filter");
});

test("extractOutputText skips non-message output items", () => {
  assert.equal(extractOutputText({
    output: [
      { type: "reasoning", content: [{ text: "hidden" }] },
      { type: "message", content: [{ type: "text", text: "shown" }] }
    ]
  }), "shown");
});

test("toChatUsage converts Responses usage into Chat Completions usage", () => {
  assert.deepEqual(toChatUsage({
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens: 6,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 16
  }), {
    prompt_tokens: 10,
    completion_tokens: 6,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 2 }
  });

  assert.deepEqual(toChatUsage({ prompt_tokens: 3, completion_tokens: 2 }), {
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5
  });

  assert.deepEqual(toChatUsage({ input_tokens_details: {}, output_tokens_details: null }), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  });

  assert.equal(toChatUsage(undefined), undefined);
  assert.equal(toChatUsage("usage"), undefined);
});
