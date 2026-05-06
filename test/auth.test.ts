import test from "node:test";
import assert from "node:assert/strict";

import { validateProxyAuth } from "../src/auth.js";
import { HttpError } from "../src/http.js";

test("validateProxyAuth allows requests when PROXY_API_KEY is unset", () => {
  assert.doesNotThrow(() => validateProxyAuth({}, undefined));
});

test("validateProxyAuth requires exact bearer token when PROXY_API_KEY is set", () => {
  assert.doesNotThrow(() => validateProxyAuth({ authorization: "Bearer secret" }, "secret"));

  assert.throws(
    () => validateProxyAuth({ authorization: "Bearer wrong" }, "secret"),
    (error: unknown) => error instanceof HttpError && error.status === 401
  );
});
