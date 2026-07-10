import assert from "node:assert/strict";
import test from "node:test";

import { JsonLogger } from "../src/logger.js";
import { MetricsRegistry } from "../src/metrics.js";

test("structured logger redacts secrets and request bodies", () => {
  const lines: string[] = [];
  const logger = new JsonLogger((line) => lines.push(line));
  logger.info("test_event", {
    requestId: "req_1",
    authorization: "Bearer secret",
    nested: { refreshToken: "refresh", safe: "visible" },
    body: { prompt: "private" },
  });
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(event.event, "test_event");
  assert.equal(event.authorization, "[REDACTED]");
  assert.deepEqual(event.nested, { refreshToken: "[REDACTED]", safe: "visible" });
  assert.equal(event.body, "[REDACTED]");
  assert.doesNotMatch(lines[0] ?? "", /Bearer secret|private|refresh"/);
});

test("metrics use bounded route and upstream result labels", () => {
  const metrics = new MetricsRegistry();
  metrics.recordRequest("GET", "/healthz", 200);
  metrics.record("success", 1);
  metrics.recordFailure("/v1/responses", "timeout");
  metrics.streamStarted();
  const rendered = metrics.render();
  assert.match(rendered, /codex_proxy_http_requests_total\{method="GET",route="\/healthz",status="200"\} 1/);
  assert.match(rendered, /codex_proxy_upstream_requests_total\{result="success"\} 1/);
  assert.match(rendered, /codex_proxy_active_streams 1/);
  assert.match(rendered, /codex_proxy_request_failures_total\{route="\/v1\/responses",failure="timeout"\} 1/);
});
