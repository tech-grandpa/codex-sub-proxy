import assert from "node:assert/strict";
import test from "node:test";

import { chatToResponsesPayload, extractOutputText, responsesToChatCompletion } from "../src/chat.js";
import { HttpError } from "../src/http.js";

function assertInvalidRequest(run: () => unknown, message: string): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof HttpError
      && error.status === 400
      && error.code === "invalid_request"
      && error.message === message
  );
}

test("chatToResponsesPayload validates model and messages", () => {
  assertInvalidRequest(
    () => chatToResponsesPayload({ messages: [] }),
    "model is required"
  );
  assertInvalidRequest(
    () => chatToResponsesPayload({ model: "gpt-5.5", messages: "hello" }),
    "messages must be an array"
  );
  assertInvalidRequest(
    () => chatToResponsesPayload({ model: "gpt-5.5", messages: [null] }),
    "Each message must be an object"
  );
  assertInvalidRequest(
    () => chatToResponsesPayload({ model: "gpt-5.5", messages: [{}] }),
    "Each message must include a role"
  );
  assertInvalidRequest(
    () => chatToResponsesPayload({ model: "gpt-5.5", messages: [{ role: "tool", content: "result" }] }),
    "Unsupported chat message role: tool"
  );
});

test("chatToResponsesPayload normalizes supported content shapes", () => {
  const payload = chatToResponsesPayload({
    model: "gpt-5.5",
    stream: true,
    messages: [
      { role: "system", content: [{ type: "input_text", text: "Rule one" }, { content: "Rule two" }] },
      { role: "user", content: null },
      { role: "assistant", content: 42 },
      {
        role: "user",
        content: [
          "plain text",
          { type: "input_image", image_url: "https://example.test/image.png" },
          { type: "file", file: "invalid" },
          false
        ]
      }
    ]
  });

  assert.equal(payload.instructions, "Rule one\nRule two");
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.input, [
    { role: "user", content: "" },
    { role: "assistant", content: "42" },
    {
      role: "user",
      content: [
        { type: "input_text", text: "plain text" },
        { type: "input_image", image_url: "https://example.test/image.png" }
      ]
    }
  ]);
});

test("chatToResponsesPayload maps valid web search location options", () => {
  const nestedLocation = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [],
    web_search_options: {
      search_context_size: "medium",
      user_location: { type: "approximate", approximate: { country: "DE" } }
    }
  });
  assert.deepEqual(nestedLocation.tools, [{
    type: "web_search",
    search_context_size: "medium",
    user_location: { type: "approximate", country: "DE" }
  }]);

  const flatLocation = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [],
    web_search_options: {
      user_location: { type: "approximate", country: "DE" }
    }
  });
  assert.deepEqual(flatLocation.tools, [{
    type: "web_search",
    user_location: { type: "approximate", country: "DE" }
  }]);

  const invalidLocation = chatToResponsesPayload({
    model: "gpt-5.5",
    messages: [],
    web_search_options: { user_location: { type: "exact", country: "DE" } }
  });
  assert.deepEqual(invalidLocation.tools, [{ type: "web_search" }]);
});

test("extractOutputText ignores malformed output entries", () => {
  assert.equal(extractOutputText(null), "");
  assert.equal(extractOutputText({ output: "not-an-array" }), "");
  assert.equal(extractOutputText({
    output: [null, { content: "invalid" }, { content: [null, { text: 1 }, { text: "ok" }] }]
  }), "ok");
});

test("responsesToChatCompletion handles incomplete and malformed upstream responses", () => {
  const incomplete = responsesToChatCompletion({ status: "incomplete", output_text: "partial" }, "gpt-5.5");
  assert.equal((incomplete.choices as Array<Record<string, unknown>>)[0]?.finish_reason, "length");
  assert.equal(incomplete.usage, undefined);

  const malformed = responsesToChatCompletion(null, "gpt-5.5");
  const choices = malformed.choices as Array<{ message: { content: string }, finish_reason: string }>;
  assert.equal(choices[0]?.message.content, "");
  assert.equal(choices[0]?.finish_reason, "stop");
});
