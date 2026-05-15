# codex-sub-proxy

Small-footprint OpenAI-compatible HTTP proxy for internal tools that need to call ChatGPT/Codex subscription-backed GPT models through the private ChatGPT Codex backend.

## Table Of Contents

- [Marketing Section](#marketing-section)
- [Important Warning](#important-warning)
- [What It Supports](#what-it-supports)
- [Docker Quick Start](#docker-quick-start)
- [Docker Images](#docker-images)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Curl Examples](#curl-examples)
- [Files](#files)
- [Smoke Test](#smoke-test)
- [Client Configuration](#client-configuration)
- [Developer Workflow](#developer-workflow)
- [CI And Publishing](#ci-and-publishing)
- [Troubleshooting](#troubleshooting)
- [Security Notes](#security-notes)
- [License](#license)

## Marketing Section

`codex-sub-proxy` is useful when you already have ChatGPT/Codex subscription access and want a small OpenAI-compatible HTTP surface for trusted internal tools.

Common use cases:

- Connect LiteLLM-like clients or transcription analyzers to subscription-backed Codex models.
- Run a private sidecar service that exposes `/v1/chat/completions` or `/v1/responses` to older internal clients.
- Give local automation, batch analysis scripts, or internal dashboards one stable base URL while the private Codex backend shape changes.
- Test Codex-backed workflows without deploying a larger gateway.

The project aims to be tiny, auditable, Docker-friendly, and explicit about its limits.

## Important Warning

This project uses unofficial/private ChatGPT/Codex backend behavior. It may violate provider terms, may stop working without notice, and should be used only where you have reviewed the legal, security, and operational risk.

Do not expose this service directly to the public internet. Put it behind a private network boundary and always set `PROXY_API_KEY` outside isolated local development.

## What It Supports

Implemented routes:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`

This is not a transparent full OpenAI API proxy. It implements a small compatibility layer:

- `/v1/chat/completions` converts chat messages into a Responses-style upstream request.
- `/v1/responses` accepts string `input` and normalizes it into the list shape currently required by the private Codex backend.
- `/v1/responses` with `stream: true` relays upstream Responses SSE events.
- `/v1/chat/completions` with `stream: true` translates upstream Responses SSE into OpenAI-style `chat.completion.chunk` events.
- Non-streaming callers still receive regular JSON because the proxy collapses upstream SSE internally.
- Structured Responses content parts are preserved, including `input_file` parts.
- Chat-style `{ "type": "file", "file": { ... } }` content parts are mapped to Responses `input_file` parts.
- `/v1/models` returns the configured local model list, not a live upstream model catalog.

Not supported:

- Transparent pass-through of every OpenAI field
- Tools/function calling compatibility
- `/v1/files` upload/list/delete endpoints
- Embeddings, images, audio, Assistants, or batch APIs
- Full multimodal chat compatibility beyond text and file content parts

## Docker Quick Start

Create an env file:

```sh
cp .env.example .env
```

Generate ChatGPT/Codex OAuth credentials with the Docker image:

```sh
docker run --rm ghcr.io/tech-grandpa/codex-sub-proxy:latest \
  node dist/src/cli/login.js
```

The command prints a device URL and code to stderr. Open the URL, authorize the code, and the command writes JSON credentials to stdout:

```json
{
  "refresh_token": "...",
  "access_token": "...",
  "expires_at": 1760000000
}
```

Put those values into `.env`:

```sh
PROXY_API_KEY=choose-a-long-random-local-key
OPENAI_REFRESH_TOKEN=...
OPENAI_ACCESS_TOKEN=...
OPENAI_EXPIRES_AT=...
```

Run the published image:

```sh
docker run --rm \
  --name codex-sub-proxy \
  -p 3000:3000 \
  --env-file .env \
  ghcr.io/tech-grandpa/codex-sub-proxy:latest
```

Or use Docker Compose:

```sh
cp .env.example .env
docker compose up
```

To point Compose at a different env file:

```sh
ENV_FILE=/path/to/proxy.env docker compose up
```

Stop the named container:

```sh
docker rm -f codex-sub-proxy
```

## Docker Images

Images are published to GitHub Container Registry:

```text
ghcr.io/tech-grandpa/codex-sub-proxy
```

Useful tags:

- `latest`: current default branch image
- `main`: current `main` branch image
- `sha-<commit>`: immutable commit image
- `<git-tag>`: release tag image, for example `v0.1.0`

If a newly published GHCR package is private, make the package public in the repository/package settings before asking regular users to pull it.

## Configuration

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `HOST` | `0.0.0.0` | No | Bind address inside the container. |
| `PORT` | `3000` | No | HTTP port inside the container. |
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

Streaming Responses:

```sh
curl -N http://localhost:3000/v1/responses \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "stream": true,
    "input": "Say the proxy works."
  }'
```

Streaming chat completions:

```sh
curl -N http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Say the proxy works." }
    ]
  }'
```

## Files

The proxy does not implement OpenAI's `/v1/files` upload/list/delete API. Those routes return a clear `501` response. There is no confirmed stable private Codex file-upload route in this project.

What does work is passing file content through model requests when the backend accepts it:

- `/v1/responses` preserves `input_file` content parts.
- `/v1/chat/completions` maps chat content parts shaped like `{ "type": "file", "file": { ... } }` into Responses `input_file` parts.
- Text-only chat content arrays remain text for broad compatibility.

Inline file example:

```sh
curl -s http://localhost:3000/v1/responses \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Summarize this file." },
          {
            "type": "input_file",
            "filename": "notes.txt",
            "file_data": "data:text/plain;base64,aGVsbG8="
          }
        ]
      }
    ]
  }'
```

Use inline `file_data` data URLs or upstream-supported file identifiers if your account/backend accepts them.

## Smoke Test

After starting the service, run:

```sh
ENV_FILE=.env ./scripts/smoke-test.sh
```

The script checks:

- `/healthz`
- unauthenticated `/v1/models` rejection
- authenticated `/v1/models`
- live `/v1/chat/completions`
- live `/v1/responses`
- live `/v1/chat/completions` streaming
- live `/v1/responses` streaming

Use a different base URL:

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

Use `/v1/chat/completions` for clients that still send chat messages. The proxy converts `system` and `developer` messages into `instructions`, converts `user` and `assistant` messages into Responses `input` items, forwards to Codex Responses, and returns either a non-streaming `chat.completion` response or streaming `chat.completion.chunk` events.

## Developer Workflow

Use the npm workflow when you are changing the project:

```sh
npm install
npm test
npm run typecheck
npm run build
npm start
```

Run the login helper without Docker:

```sh
npm run build
npm run login
```

Build a local development image:

```sh
docker build -t codex-sub-proxy:local .
docker run --rm \
  --name codex-sub-proxy-local \
  -p 3000:3000 \
  --env-file .env \
  codex-sub-proxy:local
```

The unit test suite uses Node's built-in test runner and does not call the real ChatGPT backend. The smoke script does call the live backend.

## CI And Publishing

GitHub Actions are defined in `.github/workflows/ci.yml`.

On every push and pull request:

- Install Node.js 22 dependencies with `npm ci`
- Run `npm test`

On every push:

- Build the Docker image
- Push it to GitHub Container Registry
- Publish branch, SHA, and tag-based image tags

When you push a Git tag such as `v0.1.0`, the workflow publishes:

```text
ghcr.io/tech-grandpa/codex-sub-proxy:v0.1.0
```

The default branch also publishes `latest`.

## Troubleshooting

`401 Unauthorized` from the proxy:

- Check that `PROXY_API_KEY` is set in the server environment.
- Check that the client sends `Authorization: Bearer ${PROXY_API_KEY}`.

`502 upstream_error`:

- The private ChatGPT/Codex backend rejected the request.
- Re-run the login helper if credentials may be expired.
- Confirm `CODEX_RESPONSES_PATH=/responses`.
- Confirm the account has Codex access.
- Check whether ChatGPT changed the private backend route or request contract.

Docker cannot bind port `3000`:

- Another process is already listening on that port.
- Stop it or map a different host port, for example `-p 3001:3000`.

## Security Notes

- Never commit `.env` or real OAuth credentials.
- Treat `OPENAI_REFRESH_TOKEN` like a password.
- Prefer private networking, firewall rules, or a trusted reverse proxy in front of this service.
- Set `PROXY_API_KEY` for every non-local deployment.
- Avoid logging prompts, completions, API keys, or OAuth tokens.

## License

Apache-2.0
