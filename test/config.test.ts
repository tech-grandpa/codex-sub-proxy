import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("loadConfig validates PORT before server startup", () => {
  assert.equal(loadConfig({ PORT: "0" }).port, 0);
  assert.equal(loadConfig({ PORT: "65535" }).port, 65_535);

  for (const port of ["", "3000.5", "-1", "65536", "not-a-port"]) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT must be an integer/);
  }
});

test("loadConfig validates operational limits and exposes safe defaults", () => {
  const config = loadConfig({});
  assert.equal(config.upstreamConnectTimeoutMs, 10_000);
  assert.equal(config.upstreamResponseTimeoutMs, 120_000);
  assert.equal(config.upstreamIdleTimeoutMs, 30_000);
  assert.equal(config.maxConcurrentStreams, 100);
  assert.equal(config.maxConnections, 1_000);
  assert.equal(config.maxRequestBytes, 1_000_000);

  for (const [name, value] of [
    ["UPSTREAM_CONNECT_TIMEOUT_MS", "0"],
    ["UPSTREAM_RESPONSE_TIMEOUT_MS", "NaN"],
    ["MAX_CONCURRENT_STREAMS", "1.5"],
    ["MAX_CONNECTIONS", "0"],
    ["MAX_REQUEST_BYTES", "-1"],
  ]) {
    assert.throws(() => loadConfig({ [name]: value }), new RegExp(`${name} must be a positive integer`));
  }
});
