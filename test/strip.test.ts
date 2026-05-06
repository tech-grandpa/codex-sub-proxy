import test from "node:test";
import assert from "node:assert/strict";

import { stripUnsupportedParams } from "../src/strip.js";

test("stripUnsupportedParams removes Codex-unsupported Responses parameters", () => {
  const stripped = stripUnsupportedParams({
    model: "gpt-5.5",
    input: "hello",
    max_output_tokens: 100,
    metadata: { a: "b" },
    prompt_cache_retention: "24h",
    service_tier: "auto",
    temperature: 0.4
  });

  assert.deepEqual(stripped, {
    model: "gpt-5.5",
    input: "hello"
  });
});
