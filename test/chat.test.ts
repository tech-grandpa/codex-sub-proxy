import test from "node:test";
import assert from "node:assert/strict";

import { chatToResponsesPayload, extractOutputText, responsesToChatCompletion } from "../src/chat.js";

test("chatToResponsesPayload converts system and developer messages into instructions", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "System rules" },
      { role: "developer", content: "Developer rules" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] }
    ],
    temperature: 0.8
  });

  assert.equal(payload.model, "gpt-5.5");
  assert.equal(payload.instructions, "System rules\n\nDeveloper rules");
  assert.deepEqual(payload.input, [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" }
  ]);
  assert.equal(payload.stream, false);
  assert.equal(payload.temperature, 0.8);
});

test("chatToResponsesPayload preserves structured file content", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize this file." },
          { type: "file", file: { filename: "notes.txt", file_data: "data:text/plain;base64,aGVsbG8=" } }
        ]
      }
    ]
  });

  assert.deepEqual(payload.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "Summarize this file." },
        { type: "input_file", filename: "notes.txt", file_data: "data:text/plain;base64,aGVsbG8=" }
      ]
    }
  ]);
});

test("chatToResponsesPayload maps web_search_options to a Responses web_search tool", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    web_search_options: {},
    messages: [{ role: "user", content: "Find current news." }]
  });

  assert.deepEqual(payload.tools, [{ type: "web_search" }]);
  assert.equal(payload.tool_choice, "auto");
  assert.equal(payload.web_search_options, undefined);
});

test("chatToResponsesPayload preserves explicit tools when web_search_options is also present", () => {
  const tools = [{ type: "web_search", search_context_size: "low" }];
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    tools,
    tool_choice: "required",
    web_search_options: {},
    messages: [{ role: "user", content: "Find current news." }]
  });

  assert.deepEqual(payload.tools, tools);
  assert.equal(payload.tool_choice, "required");
  assert.equal(payload.web_search_options, undefined);
});

test("extractOutputText supports output_text and Responses output arrays", () => {
  assert.equal(extractOutputText({ output_text: "direct" }), "direct");
  assert.equal(
    extractOutputText({
      output: [
        {
          content: [
            { type: "output_text", text: "hello " },
            { type: "output_text", text: "world" }
          ]
        }
      ]
    }),
    "hello world"
  );
});

test("responsesToChatCompletion returns OpenAI-compatible shape", () => {
  const completion = responsesToChatCompletion({ output_text: "ok", usage: { input_tokens: 1 } }, "gpt-5.5");
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, "gpt-5.5");
  assert.deepEqual(completion.choices, [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop"
    }
  ]);
  assert.deepEqual(completion.usage, { input_tokens: 1 });
});

test("chatToResponsesPayload translates reasoning_effort into reasoning.effort", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    reasoning_effort: "high"
  });

  assert.deepEqual(payload.reasoning, { effort: "high" });
  assert.equal(payload.reasoning_effort, undefined);
});

test("chatToResponsesPayload merges reasoning_effort into an existing reasoning object", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    reasoning: { summary: "auto" },
    reasoning_effort: "low"
  });

  assert.deepEqual(payload.reasoning, { summary: "auto", effort: "low" });
});

test("chatToResponsesPayload translates max_tokens into max_output_tokens", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 128
  });

  assert.equal(payload.max_output_tokens, 128);
  assert.equal(payload.max_tokens, undefined);

  const aliased = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    max_completion_tokens: 64
  });
  assert.equal(aliased.max_output_tokens, 64);

  const explicit = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 128,
    max_output_tokens: 32
  });
  assert.equal(explicit.max_output_tokens, 32);
});

test("chatToResponsesPayload drops fields the Codex backend rejects", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    top_p: 1,
    stream_options: { include_usage: true },
    frequency_penalty: 0.5,
    presence_penalty: 0.5,
    logprobs: true,
    seed: 42,
    totally_made_up_field: "x"
  });

  for (const field of ["top_p", "stream_options", "frequency_penalty", "presence_penalty", "logprobs", "seed", "totally_made_up_field"]) {
    assert.equal(payload[field], undefined, `${field} should be dropped`);
  }
});

test("chatToResponsesPayload forwards accepted Responses fields verbatim", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    temperature: 0.3,
    store: false,
    metadata: { trace: "1" },
    parallel_tool_calls: false,
    prompt_cache_key: "abc"
  });

  assert.equal(payload.temperature, 0.3);
  assert.equal(payload.store, false);
  assert.deepEqual(payload.metadata, { trace: "1" });
  assert.equal(payload.parallel_tool_calls, false);
  assert.equal(payload.prompt_cache_key, "abc");
});

test("chatToResponsesPayload translates chat function tools into Responses tools", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          strict: true
        }
      }
    ]
  });

  assert.deepEqual(payload.tools, [
    {
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      strict: true
    }
  ]);
});

test("chatToResponsesPayload translates chat tool_choice objects", () => {
  const forced = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    tool_choice: { type: "function", function: { name: "read_file" } }
  });
  assert.deepEqual(forced.tool_choice, { type: "function", name: "read_file" });

  const plain = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
    tool_choice: "required"
  });
  assert.equal(plain.tool_choice, "required");
});

test("chatToResponsesPayload converts assistant tool_calls and tool results into Responses input items", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "Read notes.txt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"notes.txt\"}" } }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" }
    ]
  });

  assert.deepEqual(payload.input, [
    { role: "user", content: "Read notes.txt" },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"notes.txt\"}" },
    { type: "function_call_output", call_id: "call_1", output: "file contents" }
  ]);
});

test("chatToResponsesPayload keeps assistant text alongside tool_calls", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [
      {
        role: "assistant",
        content: "Let me read that.",
        tool_calls: [{ id: "call_9", type: "function", function: { name: "read_file", arguments: {} } }]
      }
    ]
  });

  assert.deepEqual(payload.input, [
    { role: "assistant", content: "Let me read that." },
    { type: "function_call", call_id: "call_9", name: "read_file", arguments: "{}" }
  ]);
});

test("chatToResponsesPayload rejects tool messages without tool_call_id", () => {
  assert.throws(
    () =>
      chatToResponsesPayload({
        model: "gpt-5.5",
        messages: [{ role: "tool", content: "orphan" }]
      }),
    /tool_call_id/
  );
});

test("responsesToChatCompletion maps function_call output items to chat tool_calls", () => {
  const completion = responsesToChatCompletion(
    {
      output: [
        { type: "message", content: [{ type: "output_text", text: "Reading that now." }] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }
      ],
      usage: { input_tokens: 1 }
    },
    "gpt-5.5"
  );

  const choice = (completion.choices as Record<string, unknown>[])[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(choice.message, {
    role: "assistant",
    content: "Reading that now.",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }
    ]
  });
});
