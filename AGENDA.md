# Project Agenda

Generated on 2026-05-15.

## Project Snapshot

`codex-sub-proxy` is a small TypeScript/Node.js HTTP proxy that exposes an OpenAI-compatible surface for internal services while forwarding non-streaming requests to the private ChatGPT/Codex Responses backend.

The project is intentionally minimal:

- Runtime: Node.js 22, native `node:http`, native `fetch`, strict TypeScript.
- Public routes: `GET /healthz`, `GET /v1/models`, `POST /v1/responses`, and `POST /v1/chat/completions`.
- Upstream auth: ChatGPT OAuth refresh token flow with in-memory access-token caching.
- Caller auth: optional bearer-token gate through `PROXY_API_KEY`.
- Packaging: Dockerfile and Docker Compose support.
- Tests: `node:test` coverage for auth, login helper behavior, chat conversion, token refresh, URL construction, upstream SSE adaptation, and unsupported parameter stripping.

## Current Architecture

### Request Layer

`src/server.ts` owns routing, caller authentication, JSON parsing, stream rejection, and response shaping. It keeps the HTTP surface small and delegates domain work to narrow helpers.

### Authentication

`src/auth.ts` validates the caller-facing bearer token when `PROXY_API_KEY` is configured. If the key is absent, authentication is disabled, which is useful for local development but unsafe for shared or internet-facing deployments.

### Upstream Token Management

`src/upstream.ts` contains `TokenManager`, which refreshes ChatGPT OAuth access tokens using `OPENAI_REFRESH_TOKEN`, caches the current access token in memory, and coalesces concurrent refreshes through a shared promise.

### Forwarding

`src/responses.ts` strips known Codex-unsupported Responses parameters, normalizes string `input`, attaches upstream authorization headers, optionally includes `chatgpt-account-id`, forwards requests to the configured Codex Responses URL, and collapses upstream SSE events into non-streaming JSON for callers.

### Chat Compatibility

`src/chat.ts` converts OpenAI-style chat-completion requests into Responses payloads:

- `system` and `developer` messages become joined `instructions`.
- `user` and `assistant` messages become Responses `input` messages.
- The upstream Responses result is converted back into a non-streaming `chat.completion` object.

### Configuration

`src/config.ts` reads environment variables for server binding, proxy auth, ChatGPT credentials, Codex upstream routing, and the model list returned by `/v1/models`.

## Strengths

- The codebase is compact and easy to reason about.
- Core behavior is dependency-light, which makes deployment and auditing simpler.
- The proxy has a clear separation between HTTP routing, auth, conversion, forwarding, and token management.
- Caller-facing streaming is explicitly rejected with a `501` instead of silently behaving incorrectly.
- Tests cover the highest-risk pure logic and token-refresh behavior.
- Docker packaging is straightforward and includes a health check.
- A smoke-test script now verifies the main local or Docker deployment path against a live upstream account.

## Key Risks

- The upstream ChatGPT/Codex API is private and may change without notice.
- The default caller-auth behavior allows unauthenticated access when `PROXY_API_KEY` is unset.
- Refreshed access and refresh tokens are cached only in memory, so restarts depend on the originally configured credentials.
- Upstream error details are intentionally collapsed into a generic `502`, which is safer but can slow diagnosis.
- Chat compatibility is text-oriented and does not fully preserve every possible OpenAI chat message shape.
- Caller-facing streaming support is not implemented.
- The smoke test depends on private upstream availability and a valid ChatGPT/Codex account.

## Recommended Agenda

### 1. Operational Hardening

- Require `PROXY_API_KEY` outside explicit local-development mode.
- Add startup validation for required upstream credentials before accepting traffic.
- Add structured request logging with redaction for tokens, API keys, and message content.
- Add configurable request timeout handling for upstream calls.
- Consider graceful shutdown for container restarts and deploys.

### 2. Upstream Compatibility

- Keep the automated smoke-test script current for `/v1/models`, `/v1/responses`, and `/v1/chat/completions`.
- Document how to update `CODEX_RESPONSES_PATH` when the private backend route changes.
- Add tests for upstream non-JSON responses and failed upstream calls.
- Track unsupported Responses fields in one place with rationale and observed upstream behavior.

### 3. API Compatibility

- Expand chat conversion tests for multipart content, empty conversations, assistant history, and unsupported roles.
- Decide whether to support common OpenAI fields such as `max_tokens`, `stop`, `tool_choice`, and tools.
- Preserve or map usage fields into the closest chat-completion-compatible shape.
- Consider returning model availability metadata that makes client configuration easier.

### 4. Streaming Strategy

- Keep the current explicit caller-facing `501` behavior until streaming is intentionally designed.
- If streaming becomes necessary, define the exact SSE contract for both Responses and Chat Completions clients.
- Add client compatibility tests before exposing streaming in production.

### 5. Security Review

- Confirm the intended deployment boundary and make sure the service is never public by accident.
- Review token handling in logs, shell history, `.env`, Docker, and crash output.
- Add rate limiting or network-level restrictions if multiple services will share the proxy.
- Document the legal and provider-terms risk for every deployment environment.

### 6. Test And Release Process

- Keep `npm test`, `npm run typecheck`, and `npm run build` as the minimum pre-release checks.
- Add a smoke-test script that can run against `localhost:3000` with safe sample prompts.
- Add CI once the repository is hosted remotely.
- Version the Docker image and document rollback steps.

## Immediate Next Steps

1. Add startup configuration validation for production-like deployments.
2. Add upstream timeout and logging with careful redaction.
3. Expand tests around request conversion and upstream failure handling.
4. Write a short deployment runbook covering `.env`, Docker, auth, smoke tests, and rollback.
5. Decide whether streaming support is in scope or should remain explicitly unsupported.
