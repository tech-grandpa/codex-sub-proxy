import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createProxyRuntime, shutdownServer } from "../src/server.js";

test("runtime applies connection limits and shuts down gracefully", async () => {
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    HEADERS_TIMEOUT_MS: "12345",
    REQUEST_TIMEOUT_MS: "23456",
    KEEP_ALIVE_TIMEOUT_MS: "3456",
    MAX_CONNECTIONS: "12",
    SHUTDOWN_GRACE_MS: "1000",
  });
  const runtime = createProxyRuntime(config, silentLogger);
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  assert.equal(runtime.server.headersTimeout, 12_345);
  assert.equal(runtime.server.requestTimeout, 23_456);
  assert.equal(runtime.server.keepAliveTimeout, 3_456);
  assert.equal(runtime.server.maxConnections, 12);
  await runtime.shutdown("test");
  assert.equal(runtime.server.listening, false);
  await runtime.shutdown("test-again");
});

test("graceful shutdown force-closes requests after the configured drain cap", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("started");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}`);
  const started = performance.now();
  await shutdownServer(server, 20, silentLogger, "test-timeout");
  assert.equal(server.listening, false);
  assert.ok(performance.now() - started < 500);
  await assert.rejects(response.text());
});
