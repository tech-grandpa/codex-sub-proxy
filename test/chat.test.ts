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
