import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { validateProxyAuth } from "./auth.js";
import { loadConfig, type Config } from "./config.js";
import { chatToResponsesPayload, responsesToChatCompletion } from "./chat.js";
import { errorResponse, HttpError, notImplemented, readJson, requireObject, sendJson } from "./http.js";
import { CodexResponsesForwarder, type ResponsesForwarder } from "./responses.js";
import { TokenManager } from "./upstream.js";

export interface AppDeps {
  config: Config;
  forwarder: ResponsesForwarder;
}

export function createApp(deps: AppDeps) {
  return async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, { status: 200, body: { ok: true } });
        return;
      }

      validateProxyAuth(req.headers, deps.config.proxyApiKey);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, {
          status: 200,
          body: {
            object: "list",
            data: deps.config.codexModels.map((id) => ({
              id,
              object: "model",
              created: 0,
              owned_by: "openai"
            }))
          }
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const payload = requireObject(await readJson(req));
        if (payload.stream === true) {
          sendJson(res, notImplemented("Streaming /v1/responses is not implemented; send stream=false or omit stream"));
          return;
        }
        const upstream = await deps.forwarder.forward({ ...payload, stream: false });
        sendJson(res, { status: 200, body: upstream });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = requireObject(await readJson(req));
        if (payload.stream === true) {
          sendJson(res, notImplemented("Streaming /v1/chat/completions is not implemented; send stream=false or omit stream"));
          return;
        }
        const responsesPayload = chatToResponsesPayload(payload);
        const upstream = await deps.forwarder.forward({ ...responsesPayload, stream: false });
        sendJson(res, {
          status: 200,
          body: responsesToChatCompletion(upstream, responsesPayload.model)
        });
        return;
      }

      throw new HttpError(404, "not_found", "Route not found");
    } catch (error) {
      sendJson(res, errorResponse(error));
    }
  };
}

export function startServer(config = loadConfig()): void {
  const tokenManager = new TokenManager(config);
  const forwarder = new CodexResponsesForwarder(config, tokenManager);
  const server = createServer(createApp({ config, forwarder }));

  server.listen(config.port, config.host, () => {
    console.log(`codex-sub-proxy listening on http://${config.host}:${config.port}`);
    if (!config.proxyApiKey) {
      console.warn("PROXY_API_KEY is unset; caller authentication is disabled and unsafe outside local dev.");
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
