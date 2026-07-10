import assert from "node:assert/strict";
import test from "node:test";

import { chatToResponsesPayload, extractOutputText, responsesToChatCompletion } from "../src/chat.js";

test("chatToResponsesPayload converts system and developer messages into instructions", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "System rules" },
      { role: "developer", content: "Developer rules" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ],
    temperature: 0.8,
  });

  assert.equal(payload.model, "gpt-5.5");
  assert.equal(payload.instructions, "System rules\n\nDeveloper rules");
  assert.deepEqual(payload.input, [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
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
          { type: "file", file: { filename: "notes.txt", file_data: "data:text/plain;base64,aGVsbG8=" } },
        ],
      },
    ],
  });

  assert.deepEqual(payload.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "Summarize this file." },
        { type: "input_file", filename: "notes.txt", file_data: "data:text/plain;base64,aGVsbG8=" },
      ],
    },
  ]);
});

test("chatToResponsesPayload maps web_search_options to a Responses web_search tool", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    web_search_options: {},
    messages: [{ role: "user", content: "Find current news." }],
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
    messages: [{ role: "user", content: "Find current news." }],
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
            { type: "output_text", text: "world" },
          ],
        },
      ],
    }),
    "hello world",
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
      finish_reason: "stop",
    },
  ]);
  assert.deepEqual(completion.usage, { prompt_tokens: 1, completion_tokens: 0, total_tokens: 0 });
});

test("chatToResponsesPayload maps function tools, calls, and tool results", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    tools: [
      {
        type: "function",
        function: { name: "weather", description: "Get weather", parameters: { type: "object" }, strict: true },
      },
    ],
    tool_choice: { type: "function", function: { name: "weather" } },
    messages: [
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Berlin"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: { temperature: 20 } },
    ],
  });

  assert.deepEqual(payload.tools, [
    { type: "function", name: "weather", description: "Get weather", parameters: { type: "object" }, strict: true },
  ]);
  assert.deepEqual(payload.tool_choice, { type: "function", name: "weather" });
  assert.deepEqual(payload.input, [
    { role: "user", content: "Weather?" },
    { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Berlin"}' },
    { type: "function_call_output", call_id: "call_1", output: '{"temperature":20}' },
  ]);
});

test("responsesToChatCompletion maps tools, refusal, annotations, usage, and non-text output", () => {
  const completion = responsesToChatCompletion(
    {
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "See source",
              annotations: [{ type: "url_citation", url: "https://example.test" }],
            },
            { type: "refusal", refusal: "I cannot do that" },
          ],
        },
        { type: "function_call", call_id: "call_7", name: "lookup", arguments: '{"id":7}' },
        { type: "image_generation_call", id: "image_1", result: "base64" },
        { type: "reasoning", summary: [] },
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    },
    "gpt-5.5",
  );

  const choice = (completion.choices as Array<Record<string, unknown>>)[0];
  assert.equal(choice?.finish_reason, "tool_calls");
  assert.deepEqual(choice?.message, {
    role: "assistant",
    content: "See source",
    tool_calls: [{ id: "call_7", type: "function", function: { name: "lookup", arguments: '{"id":7}' } }],
    refusal: "I cannot do that",
    annotations: [{ type: "url_citation", url: "https://example.test" }],
    response_output: [{ type: "image_generation_call", id: "image_1", result: "base64" }],
  });
  assert.deepEqual(completion.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
});

test("responsesToChatCompletion uses null content for tool-only output and length for incomplete calls", () => {
  const completion = responsesToChatCompletion(
    {
      status: "incomplete",
      output: [
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        { type: "message", content: [{ type: "output_image", image_url: "data:image/png;base64,abc" }] },
      ],
    },
    "gpt-5.5",
  );
  const choice = (completion.choices as Array<Record<string, unknown>>)[0];
  assert.equal(choice?.finish_reason, "length");
  assert.deepEqual(choice?.message, {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    response_output: [{ type: "output_image", image_url: "data:image/png;base64,abc" }],
  });
});

test("chatToResponsesPayload rejects invalid message content instead of stringifying it", () => {
  assert.throws(
    () =>
      chatToResponsesPayload({
        model: "gpt-5.5",
        messages: [{ role: "user", content: { unexpected: true } }],
      }),
    /Message content must be a string, an array, or null/,
  );
});
