import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectResponsesSse, ResponsesSseDecoder } from "../src/sse.js";

test("shared SSE decoder handles chunk boundaries, UTF-8, comments, and multiline data", () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta",\ndata: "delta":"Grüße"}\n\n',
  );
  const split = bytes.indexOf(0xc3) + 1;
  const decoder = new ResponsesSseDecoder();
  assert.deepEqual(decoder.push(bytes.slice(0, split)), []);
  assert.deepEqual(decoder.push(bytes.slice(split)), [{ type: "response.output_text.delta", delta: "Grüße" }]);
  assert.deepEqual(decoder.finish(), []);
});

test("shared SSE collector parses the recorded upstream contract fixture", async () => {
  const fixture = await readFile(new URL("../../test/fixtures/responses-text.sse", import.meta.url), "utf8");
  assert.deepEqual(collectResponsesSse(fixture), {
    id: "resp_fixture",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "hello world" }] }],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    output_text: "hello world",
  });
});

test("shared SSE decoder rejects malformed and failed upstream events", () => {
  const malformed = new ResponsesSseDecoder();
  assert.throws(() => malformed.push("data: not-json\n\n"), /malformed SSE JSON/);
  assert.throws(
    () => collectResponsesSse('data: {"type":"response.failed","error":{"message":"model failed"}}\n\n'),
    /model failed/,
  );
  assert.throws(
    () => collectResponsesSse('data: {"type":"response.output_text.delta","delta":"truncated"}\n\n'),
    /ended without a completed response/,
  );
});
