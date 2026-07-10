import assert from "node:assert/strict";
import test from "node:test";

import { errorResponse, HttpError } from "../src/http.js";

test("errorResponse preserves client-safe HTTP errors", () => {
  assert.deepEqual(errorResponse(new HttpError(400, "invalid_request", "Bad input")), {
    status: 400,
    body: {
      error: {
        type: "invalid_request",
        message: "Bad input",
      },
    },
  });
});

test("errorResponse does not expose unexpected internal error details", () => {
  assert.deepEqual(errorResponse(new Error("secret implementation detail")), {
    status: 500,
    body: {
      error: {
        type: "internal_error",
        message: "Internal server error",
      },
    },
  });
});
