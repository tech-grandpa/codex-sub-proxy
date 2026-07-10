import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { validateProxyAuth } from "./auth.js";
import { chatToResponsesPayload, responsesToChatCompletion } from "./chat.js";
import type { Config } from "./config.js";
import { errorResponse, HttpError, notImplemented, readJson, sendJson, sendText } from "./http.js";
import { type Logger, silentLogger } from "./logger.js";
import { MetricsRegistry, type RequestFailure } from "./metrics.js";
import type { ResponsesForwarder } from "./responses.js";
import { parseChatRequest, parseResponsesRequest } from "./schemas.js";
import { sendChatCompletionStream, sendResponsesStream } from "./streaming.js";

export interface AppDeps {
  config: Config;
  forwarder: ResponsesForwarder;
  logger?: Logger;
  metrics?: MetricsRegistry;
}

export function createApp(deps: AppDeps) {
  const logger = deps.logger ?? silentLogger;
  const metrics = deps.metrics ?? new MetricsRegistry();
  let activeStreams = 0;

  return async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const requestId = getRequestId(req);
    const method = req.method ?? "UNKNOWN";
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routeLabel(method, url.pathname);
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort(new Error("Downstream connection closed"));
    };
    req.once("aborted", abort);
    res.once("close", abort);
    res.setHeader("X-Request-Id", requestId);

    try {
      if (method === "GET" && url.pathname === "/healthz") {
        sendJson(res, { status: 200, body: { ok: true } });
        return;
      }

      validateProxyAuth(req.headers, deps.config.proxyApiKey);

      if (method === "GET" && url.pathname === "/metrics") {
        sendText(res, 200, metrics.render(), "text/plain; version=0.0.4; charset=utf-8");
        return;
      }
      if (method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, { status: 200, body: modelsResponse(deps.config) });
        return;
      }
      if (url.pathname === "/v1/files" || url.pathname.startsWith("/v1/files/")) {
        sendJson(
          res,
          notImplemented("/v1/files is not implemented; pass file content as Responses input_file parts instead"),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/v1/responses") {
        const payload = parseResponsesRequest(await readJson(req, deps.config.maxRequestBytes));
        if (payload.stream === true) {
          acquireStream();
          try {
            await sendResponsesStream(res, await deps.forwarder.stream(payload, { signal: controller.signal }), {
              signal: controller.signal,
              idleTimeoutMs: deps.config.upstreamIdleTimeoutMs,
            });
          } finally {
            releaseStream();
          }
          return;
        }
        const upstream = await deps.forwarder.forward({ ...payload, stream: false }, { signal: controller.signal });
        sendJson(res, { status: 200, body: upstream });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = parseChatRequest(await readJson(req, deps.config.maxRequestBytes));
        const responsesPayload = chatToResponsesPayload(payload);
        if (payload.stream === true) {
          acquireStream();
          try {
            await sendChatCompletionStream(
              res,
              await deps.forwarder.stream(responsesPayload, { signal: controller.signal }),
              responsesPayload.model,
              {
                signal: controller.signal,
                idleTimeoutMs: deps.config.upstreamIdleTimeoutMs,
                includeUsage: isUsageStreamRequested(payload.stream_options),
              },
            );
          } finally {
            releaseStream();
          }
          return;
        }
        const upstream = await deps.forwarder.forward(
          { ...responsesPayload, stream: false },
          { signal: controller.signal },
        );
        sendJson(res, { status: 200, body: responsesToChatCompletion(upstream, responsesPayload.model) });
        return;
      }
      throw new HttpError(404, "not_found", "Route not found");
    } catch (error) {
      metrics.recordFailure(route, classifyFailure(error, controller.signal));
      logger.error("request_failed", {
        requestId,
        method,
        route,
        errorType: error instanceof HttpError ? error.code : error instanceof Error ? error.name : "unknown",
      });
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(res, errorResponse(error));
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
      const durationMs = performance.now() - started;
      metrics.recordRequest(method, route, res.statusCode, durationMs);
      logger.info("request_completed", {
        requestId,
        method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    }
  };

  function acquireStream(): void {
    if (activeStreams >= deps.config.maxConcurrentStreams) {
      throw new HttpError(429, "too_many_streams", "Concurrent stream limit reached");
    }
    activeStreams += 1;
    metrics.streamStarted();
  }

  function releaseStream(): void {
    activeStreams = Math.max(0, activeStreams - 1);
    metrics.streamFinished();
  }
}

function classifyFailure(error: unknown, signal: AbortSignal): RequestFailure {
  if (signal.aborted) return "cancelled";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof HttpError) return error.status >= 500 ? "upstream" : "client";
  return "internal";
}

function getRequestId(req: IncomingMessage): string {
  const value = req.headers["x-request-id"];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._-]{1,128}$/.test(candidate) ? candidate : randomUUID();
}

function routeLabel(method: string, path: string): string {
  if (path === "/healthz") return "/healthz";
  if (path === "/metrics") return "/metrics";
  if (path === "/v1/models") return "/v1/models";
  if (path === "/v1/responses") return "/v1/responses";
  if (path === "/v1/chat/completions") return "/v1/chat/completions";
  if (path === "/v1/files" || path.startsWith("/v1/files/")) return "/v1/files/*";
  return `${method} unknown`;
}

function modelsResponse(config: Config): Record<string, unknown> {
  return {
    object: "list",
    data: config.codexModels.map((id) => ({ id, object: "model", created: 0, owned_by: "openai" })),
  };
}

function isUsageStreamRequested(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).include_usage === true,
  );
}
