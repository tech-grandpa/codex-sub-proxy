import { createServer, type Server } from "node:http";

import { createApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { JsonLogger, type Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { CodexResponsesForwarder } from "./responses.js";
import { TokenManager } from "./upstream.js";

export { type AppDeps, createApp } from "./app.js";

export interface ProxyRuntime {
  server: Server;
  shutdown(reason?: string): Promise<void>;
}

export function createProxyRuntime(config: Config, logger: Logger = new JsonLogger()): ProxyRuntime {
  const metrics = new MetricsRegistry();
  const tokenManager = new TokenManager(config);
  const forwarder = new CodexResponsesForwarder(config, tokenManager, fetch, metrics);
  const server = createServer(createApp({ config, forwarder, logger, metrics }));
  server.headersTimeout = config.headersTimeoutMs;
  server.requestTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.maxConnections = config.maxConnections;
  server.maxRequestsPerSocket = 1_000;

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason = "requested") => {
    shutdownPromise ??= shutdownServer(server, config.shutdownGraceMs, logger, reason);
    return shutdownPromise;
  };
  return { server, shutdown };
}

export function startServer(config = loadConfig()): ProxyRuntime {
  const logger = new JsonLogger();
  const runtime = createProxyRuntime(config, logger);
  runtime.server.listen(config.port, config.host, () => {
    logger.info("server_started", { host: config.host, port: config.port });
    if (!config.proxyApiKey)
      logger.error("proxy_auth_disabled", { environment: process.env.NODE_ENV ?? "development" });
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info("shutdown_signal", { signal });
      void runtime.shutdown(signal).then(() => {
        process.exitCode = 0;
      });
    });
  }
  return runtime;
}

export async function shutdownServer(server: Server, graceMs: number, logger: Logger, reason: string): Promise<void> {
  logger.info("server_stopping", { reason, graceMs });
  server.closeIdleConnections();
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      logger.error("shutdown_grace_exceeded", { graceMs });
      server.closeAllConnections();
      resolve();
    }, graceMs);
    timeoutHandle.unref();
  });
  await Promise.race([closed, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  logger.info("server_stopped", { reason });
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
