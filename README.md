# codex-sub-proxy

Small-footprint OpenAI-compatible HTTP proxy for internal services that need to call ChatGPT/Codex subscription-backed GPT models through the ChatGPT Codex backend without running OpenClaw Gateway.

## Warning

This project uses unofficial/private ChatGPT/Codex backend behavior. It may violate provider terms, may stop working without notice, and should be used only where you have reviewed the legal, security, and operational risk. Do not expose it to the public internet.

## API

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`

Caller authentication is controlled by `PROXY_API_KEY`. When set, every route except `/healthz` requires:

```http
Authorization: Bearer ${PROXY_API_KEY}
```

Leaving `PROXY_API_KEY` unset disables caller authentication. That is unsafe outside local development.

## Upstream Routing

The proxy forwards Responses requests to:

```text
${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}
```

Defaults:

```text
CODEX_BASE_URL=https://chatgpt.com/backend-api/codex
CODEX_RESPONSES_PATH=/v1/responses
```

That produces:

```text
https://chatgpt.com/backend-api/codex/v1/responses
```

If the live ChatGPT/Codex route shape changes or your account uses a different backend path, set `CODEX_RESPONSES_PATH` after the first smoke test.

The proxy strips Codex-unsupported normal Responses parameters before forwarding:

- `max_output_tokens`
- `metadata`
- `prompt_cache_retention`
- `service_tier`
- `temperature`

Streaming is intentionally conservative for the first version. `stream=true` returns a clear `501` JSON error for both `/v1/responses` and `/v1/chat/completions`.

## Login

Build first, then run the device-code helper:

```sh
npm install
npm run build
npm run login
```

The command prints the device URL and code to stderr, polls ChatGPT auth, and writes JSON to stdout:

```json
{
  "refresh_token": "...",
  "access_token": "...",
  "expires_at": 1760000000
}
```

Put those values in `.env` as `OPENAI_REFRESH_TOKEN`, optional `OPENAI_ACCESS_TOKEN`, and optional `OPENAI_EXPIRES_AT`. Runtime token refresh uses:

```text
https://auth.openai.com/oauth/token
grant_type=refresh_token
client_id=app_EMoamEEZ73f0CkXaXp7hrann
```

No persistent database is required; refreshed tokens are cached in memory.

## Docker

```sh
cp .env.example .env
docker build -t codex-sub-proxy:local .
docker run --rm -p 3000:3000 --env-file .env codex-sub-proxy:local
```

Docker Compose:

```sh
cp .env.example .env
docker compose up --build
```

## Curl Examples

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
      { "role": "user", "content": "Summarize this transcript." }
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
    "input": "Summarize this transcript."
  }'
```

## Transcriber Analyzer Configuration

For a Python transcription service or LiteLLM-like client, point its OpenAI-compatible base URL at this proxy:

```sh
OPENAI_API_BASE=http://codex-sub-proxy:3000/v1
OPENAI_BASE_URL=http://codex-sub-proxy:3000/v1
OPENAI_API_KEY=${PROXY_API_KEY}
OPENAI_MODEL=gpt-5.5
```

Use `/v1/chat/completions` for compatibility clients that still send chat messages. The proxy converts `system` and `developer` messages into `instructions`, converts `user` and `assistant` messages into Responses `input` items, forwards to Codex Responses, and returns a non-streaming `chat.completion` response.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
npm start
```
