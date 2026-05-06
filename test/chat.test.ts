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
