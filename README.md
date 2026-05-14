# codex-sub-proxy

Small-footprint OpenAI-compatible HTTP proxy for internal tools that need to call ChatGPT/Codex subscription-backed GPT models through the private ChatGPT Codex backend.

## Important Warning

This project uses unofficial/private ChatGPT/Codex backend behavior. It may violate provider terms, may stop working without notice, and should be used only where you have reviewed the legal, security, and operational risk.

Do not expose this service directly to the public internet. Put it behind a private network boundary and always set `PROXY_API_KEY` outside local development.

## What It Supports

Implemented routes:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`

This is not a transparent full OpenAI API proxy. It implements a small compatibility layer:

- `/v1/chat/completions` converts chat messages into a Responses-style upstream request.
- `/v1/responses` accepts string `input` and normalizes it into the list shape currently required by the private Codex backend.
- Caller streaming is not implemented. Requests with `stream: true` return `501`.
- Internally, the proxy uses the upstream-required SSE transport, then collapses the result back into non-streaming JSON.
- `/v1/models` returns the configured local model list, not a live upstream model catalog.

Not supported:

- Transparent pass-through of every OpenAI field
- Caller-facing streaming
- Tools/function calling compatibility
- Files, embeddings, images, audio, Assistants, or batch APIs
- Full multimodal chat content preservation

## Quick Start

Install dependencies and build:

```sh
npm install
npm run build
```

Get ChatGPT/Codex OAuth credentials:

```sh
npm run login
```

The login command prints a URL and device code to stderr. Open the URL, authorize the device code, and the command writes JSON credentials to stdout:

```json
{
  "refresh_token": "...",
  "access_token": "...",
  "expires_at": 1760000000
}
```

Create `.env`:

```sh
cp .env.example .env
```

Fill in at least:

```sh
PROXY_API_KEY=choose-a-long-random-local-key
OPENAI_REFRESH_TOKEN=...
OPENAI_ACCESS_TOKEN=...
OPENAI_EXPIRES_AT=...
```

Run locally:

```sh
set -a
. ./.env
set +a
npm start
```

The proxy listens on `http://0.0.0.0:3000` by default.

## Docker

Build and run:

```sh
docker build -t codex-sub-proxy:local .
docker run --rm \
  --name codex-sub-proxy-local \
  -p 3000:3000 \
  --env-file .env \
  codex-sub-proxy:local
```

Docker Compose:

```sh
docker compose up --build
```

Stop the named Docker container:

```sh
docker rm -f codex-sub-proxy-local
```

## Configuration

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `HOST` | `0.0.0.0` | No | Bind address. |
| `PORT` | `3000` | No | HTTP port. |
| `PROXY_API_KEY` | unset | Strongly recommended | Caller bearer token. If unset, all routes except `/healthz` are unauthenticated. |
| `OPENAI_REFRESH_TOKEN` | unset | Yes | ChatGPT OAuth refresh token. |
| `OPENAI_ACCESS_TOKEN` | unset | No | Optional initial access token. If absent or expiring, the proxy refreshes from `OPENAI_REFRESH_TOKEN`. |
| `OPENAI_EXPIRES_AT` | unset | No | Unix timestamp in seconds or milliseconds. |
| `OPENAI_CHATGPT_ACCOUNT_ID` | unset | Sometimes | Optional account id sent as `chatgpt-account-id`. Useful when your ChatGPT session is tied to a specific account/workspace. |
| `CODEX_BASE_URL` | `https://chatgpt.com/backend-api/codex` | No | Private backend base URL. |
| `CODEX_RESPONSES_PATH` | `/responses` | No | Private backend Responses path. Change this if ChatGPT backend routing changes. |
| `CODEX_MODELS` | `gpt-5.5,gpt-5.5-pro,gpt-5.4,gpt-5.4-mini` | No | Comma-separated ids returned by `/v1/models`. |

## Authentication

When `PROXY_API_KEY` is set, every route except `/healthz` requires:

```http
Authorization: Bearer ${PROXY_API_KEY}
```

Leaving `PROXY_API_KEY` unset disables caller authentication. That mode is only appropriate for isolated local development.

## Upstream Behavior

The proxy forwards model calls to:

```text
${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}
```

Default:

```text
https://chatgpt.com/backend-api/codex/responses
```

Current private-backend requirements handled by the proxy:

- Forces upstream `store: false`
- Forces upstream `stream: true`
- Sends `Accept: text/event-stream`
- Parses upstream SSE events into a completed JSON response
- Converts string Responses `input` into `[{ "role": "user", "content": "..." }]`
- Strips known unsupported normal Responses parameters:
  - `max_output_tokens`
  - `metadata`
  - `prompt_cache_retention`
  - `service_tier`
  - `temperature`

## Curl Examples

Health:

```sh
curl -s http://localhost:3000/healthz
```

Models:

```sh
curl -s http://localhost:3000/v1/models \
  -H "Authorization: Bearer ${PROXY_API_KEY}"
```

Chat completions compatibility:

```sh
curl -s http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [
      { "role": "system", "content": "Answer tersely." },
      { "role": "user", "content": "Say the proxy works." }
    ]
  }'
```

Responses:

```sh
curl -s http://localhost:3000/v1/responses \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "instructions": "Answer tersely.",
    "input": "Say the proxy works."
  }'
```

## Smoke Test

After starting the service, run:

```sh
./scripts/smoke-test.sh
```

The script reads `.env` by default and checks:

- `/healthz`
- unauthenticated `/v1/models` rejection
- authenticated `/v1/models`
- live `/v1/chat/completions`
- live `/v1/responses`
- caller-facing streaming rejection

Use a different base URL or env file:

```sh
BASE_URL=http://localhost:3000 ENV_FILE=.env ./scripts/smoke-test.sh
```

## Client Configuration

For OpenAI-compatible clients, point the base URL at this proxy:

```sh
OPENAI_API_BASE=http://codex-sub-proxy:3000/v1
OPENAI_BASE_URL=http://codex-sub-proxy:3000/v1
OPENAI_API_KEY=${PROXY_API_KEY}
OPENAI_MODEL=gpt-5.5
```

Use `/v1/chat/completions` for clients that still send chat messages. The proxy converts `system` and `developer` messages into `instructions`, converts `user` and `assistant` messages into Responses `input` items, forwards to Codex Responses, and returns a non-streaming `chat.completion` response.

## Troubleshooting

`401 Unauthorized` from the proxy:

- Check that `PROXY_API_KEY` is set in the server environment.
- Check that the client sends `Authorization: Bearer ${PROXY_API_KEY}`.

`502 upstream_error`:

- The private ChatGPT/Codex backend rejected the request.
- Re-run `npm run login` if credentials may be expired.
- Confirm `CODEX_RESPONSES_PATH=/responses`.
- Confirm the account has Codex access.
- Check whether ChatGPT changed the private backend route or request contract.

`501 not_implemented`:

- The caller sent `stream: true`.
- Caller-facing streaming is intentionally unsupported right now.

Docker cannot bind port `3000`:

- Another process is already listening on that port.
- Stop it or map a different host port, for example `-p 3001:3000`.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
npm start
```

The test suite uses Node's built-in test runner and does not call the real ChatGPT backend.

See [AGENDA.md](./AGENDA.md) for the current project analysis, risks, and suggested next work.

## Security Notes

- Never commit `.env` or real OAuth credentials.
- Treat `OPENAI_REFRESH_TOKEN` like a password.
- Prefer private networking, firewall rules, or a trusted reverse proxy in front of this service.
- Set `PROXY_API_KEY` for every non-local deployment.
- Avoid logging prompts, completions, API keys, or OAuth tokens.

## License

MIT
