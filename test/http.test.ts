import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { errorResponse, HttpError, notImplemented, readJson, requireObject } from "../src/http.js";

function requestBody(...chunks: Array<string | Buffer>): IncomingMessage {
  return Readable.from(chunks) as unknown as IncomingMessage;
}

test("readJson parses chunked request bodies", async () => {
  const body = await readJson(requestBody("{\"hello\":", Buffer.from("\"world\"}")));

  assert.deepEqual(body, { hello: "world" });
});

test("readJson treats an empty body as an empty object", async () => {
  assert.deepEqual(await readJson(requestBody()), {});
  assert.deepEqual(await readJson(requestBody("  \n")), {});
});

test("readJson rejects malformed JSON", async () => {
  await assert.rejects(
    readJson(requestBody("not-json")),
    (error: unknown) => error instanceof HttpError
      && error.status === 400
      && error.code === "invalid_json"
  );
});

test("readJson rejects request bodies above the configured limit", async () => {
  await assert.rejects(
    readJson(requestBody("12345", "67890"), 9),
    (error: unknown) => error instanceof HttpError
      && error.status === 413
      && error.code === "request_too_large"
  );
});

test("requireObject accepts records and rejects non-object JSON values", () => {
  const value = { model: "gpt-5.5" };
  assert.equal(requireObject(value), value);

  for (const invalid of [null, [], "text", 1]) {
    assert.throws(
      () => requireObject(invalid),
      (error: unknown) => error instanceof HttpError
        && error.status === 400
        && error.code === "invalid_request"
    );
  }
});

test("errorResponse preserves public HTTP errors and hides unknown error types", () => {
  assert.deepEqual(errorResponse(new HttpError(401, "unauthorized", "Nope")), {
    status: 401,
    body: { error: { type: "unauthorized", message: "Nope" } }
  });
  assert.deepEqual(errorResponse(new Error("boom")), {
    status: 500,
    body: { error: { type: "internal_error", message: "boom" } }
  });
  assert.deepEqual(errorResponse({ unexpected: true }), {
    status: 500,
    body: { error: { type: "internal_error", message: "Unknown error" } }
  });
});

test("notImplemented returns an OpenAI-shaped 501 error", () => {
  assert.deepEqual(notImplemented("not available"), {
    status: 501,
    body: { error: { type: "not_implemented", message: "not available" } }
  });
});
