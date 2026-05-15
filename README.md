# codex-sub-proxy

Run a tiny OpenAI-compatible proxy for ChatGPT/Codex subscription-backed models.

[![CI](https://github.com/tech-grandpa/codex-sub-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/tech-grandpa/codex-sub-proxy/actions/workflows/ci.yml)
[![CodeQL](https://github.com/tech-grandpa/codex-sub-proxy/actions/workflows/codeql.yml/badge.svg)](https://github.com/tech-grandpa/codex-sub-proxy/actions/workflows/codeql.yml)
[![Security](https://github.com/tech-grandpa/codex-sub-proxy/actions/workflows/security.yml/badge.svg)](https://github.com/tech-grandpa/codex-sub-proxy/actions/workflows/security.yml)
[![Container](https://img.shields.io/badge/container-ghcr.io%2Ftech--grandpa%2Fcodex--sub--proxy-blue)](https://github.com/tech-grandpa/codex-sub-proxy/pkgs/container/codex-sub-proxy)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](./LICENSE)

`codex-sub-proxy` gives trusted internal tools a small `/v1/chat/completions` and `/v1/responses` API while it handles ChatGPT/Codex OAuth, the private Codex backend route, SSE adaptation, and a few compatibility quirks.

It is designed to be easy to run as a Docker sidecar, easy to audit, and honest about the OpenAI API surface it does not implement.

## Table Of Contents

- [Why Use It](#why-use-it)
- [Warning](#warning)
- [Quick Start](#quick-start)
- [Docker Images](#docker-images)
- [Supported API](#supported-api)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Examples](#examples)
- [Files](#files)
- [Smoke Test](#smoke-test)
- [Client Configuration](#client-configuration)
- [Development](#development)
- [CI And Publishing](#ci-and-publishing)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [License](#license)

## Why Use It

Use `codex-sub-proxy` when you already have ChatGPT/Codex subscription access and want a practical OpenAI-compatible HTTP surface for private infrastructure.

Good fits:

- Point LiteLLM-like clients, transcription analyzers, or internal automation at one stable base URL.
- Keep older tools that know `/v1/chat/completions` working while using Codex-backed Responses upstream.
- Run a small Docker sidecar instead of deploying a larger gateway.
- Support both streaming and non-streaming clients.
- Pass inline file content to Codex model requests without adding a separate storage service.

Poor fits:

- Public API gateways.
- Full OpenAI API compatibility.
- Workloads that require stable vendor-supported backend contracts.
- File upload/list/delete workflows through `/v1/files`.

## Warning

This project uses unofficial/private ChatGPT/Codex backend behavior. It may violate provider terms, may stop working without notice, and should be used only where you have reviewed the legal, security, and operational risk.

Do not expose this service directly to the public internet. Put it behind a private network boundary and always set `PROXY_API_KEY` outside isolated local development.

## Quick Start

### 1. Create `.env`

```sh
cp .env.example .env
```

### 2. Generate ChatGPT/Codex Credentials

```sh
docker run --rm ghcr.io/tech-grandpa/codex-sub-proxy:latest \
  node dist/src/cli/login.js
```

The command prints a device URL and code to stderr. Open the URL, authorize the code, and the command writes credentials to stdout:

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

### 3. Run The Proxy

```sh
docker run --rm \
  --name codex-sub-proxy \
  -p 3000:3000 \
  --env-file .env \
  ghcr.io/tech-grandpa/codex-sub-proxy:latest
```

Or with Docker Compose:

```sh
docker compose up
```

Use a different env file with Compose:

```sh
ENV_FILE=/path/to/proxy.env docker compose up
```

### 4. Verify It Responds

```sh
curl -s http://localhost:3000/healthz
```

Expected:

```json
{"ok":true}
```

## Docker Images

Images are published to GitHub Container Registry:

```text
ghcr.io/tech-grandpa/codex-sub-proxy
```

Tags:

| Tag | Meaning |
| --- | --- |
| `latest` | Current default branch image |
| `main` | Current `main` branch image |
| `sha-<commit>` | Immutable commit image |
| `<git-tag>` | Release tag image, for example `v0.1.0` |

Stop a named local container:

```sh
docker rm -f codex-sub-proxy
```

## Supported API

| Route | Status | Notes |
| --- | --- | --- |
| `GET /healthz` | Supported | Health check |
| `GET /v1/models` | Supported | Returns the configured local model list |
| `POST /v1/responses` | Supported | Streaming and non-streaming |
| `POST /v1/chat/completions` | Supported | Streaming and non-streaming chat compatibility |
| `/v1/files` | Not supported | Returns `501`; use inline `input_file` parts |
| Embeddings, audio, images, batches, Assistants | Not supported | Outside this proxy's scope |

This is not a transparent full OpenAI API proxy. It is a focused compatibility shim for model calls.

## How It Works

```text
OpenAI-compatible client
        |
        v
codex-sub-proxy
        |
        v
private ChatGPT/Codex Responses backend
```

The proxy:

- refreshes ChatGPT OAuth access tokens with `OPENAI_REFRESH_TOKEN`
- authenticates callers with `PROXY_API_KEY`
- converts chat-completion requests into Responses payloads
- relays Responses SSE for streaming `/v1/responses`
- translates upstream SSE into `chat.completion.chunk` events for streaming chat clients
- collapses upstream SSE into JSON for non-streaming clients
- preserves inline `input_file` content parts
- strips known unsupported upstream fields

Current upstream target:

```text
${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}
```

Default:

```text
https://chatgpt.com/backend-api/codex/responses
```

## Configuration

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `HOST` | `0.0.0.0` | No | Bind address inside the container |
| `PORT` | `3000` | No | HTTP port inside the container |
| `PROXY_API_KEY` | unset | Strongly recommended | Bearer token required from proxy callers |
| `OPENAI_REFRESH_TOKEN` | unset | Yes | ChatGPT OAuth refresh token |
| `OPENAI_ACCESS_TOKEN` | unset | No | Optional initial access token |
| `OPENAI_EXPIRES_AT` | unset | No | Access-token expiry as Unix seconds or milliseconds |
| `OPENAI_CHATGPT_ACCOUNT_ID` | unset | Sometimes | Optional ChatGPT account/workspace id |
| `CODEX_BASE_URL` | `https://chatgpt.com/backend-api/codex` | No | Private Codex backend base URL |
| `CODEX_RESPONSES_PATH` | `/responses` | No | Private Codex Responses path |
| `CODEX_MODELS` | `gpt-5.5,gpt-5.5-pro,gpt-5.4,gpt-5.4-mini` | No | Comma-separated ids returned by `/v1/models` |

## Examples

Set your proxy key first:

```sh
export PROXY_API_KEY=choose-a-long-random-local-key
```

### Models

```sh
curl -s http://localhost:3000/v1/models \
  -H "Authorization: Bearer ${PROXY_API_KEY}"
```

### Chat Completions

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

### Streaming Chat Completions

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

### Responses

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

### Streaming Responses

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

## Files

The proxy does not implement OpenAI's `/v1/files` upload/list/delete API. Those routes return `501`.

What works today is inline file content inside model requests:

- `/v1/responses` preserves `input_file` content parts.
- `/v1/chat/completions` maps `{ "type": "file", "file": { ... } }` chat parts to Responses `input_file` parts.
- Inline `file_data` data URLs work when the private backend accepts them.

Example:

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

## Smoke Test

After the container is running:

```sh
ENV_FILE=.env ./scripts/smoke-test.sh
```

The smoke test checks:

- health
- caller authentication
- model listing
- chat completions
- Responses
- streaming chat completions
- streaming Responses

The smoke test calls the live private backend, so it requires valid credentials.

## Client Configuration

Point OpenAI-compatible clients at:

```sh
OPENAI_BASE_URL=http://codex-sub-proxy:3000/v1
OPENAI_API_BASE=http://codex-sub-proxy:3000/v1
OPENAI_API_KEY=${PROXY_API_KEY}
OPENAI_MODEL=gpt-5.5
```

Use `/v1/chat/completions` for older clients. Use `/v1/responses` when your client can send Responses-style payloads.

## Development

Use npm only when changing or testing the project locally:

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

The unit tests use Node's built-in test runner and do not call the real ChatGPT backend.

## CI And Publishing

GitHub Actions are defined in:

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)
- [`.github/workflows/codeql.yml`](./.github/workflows/codeql.yml)
- [`.github/workflows/dependency-review.yml`](./.github/workflows/dependency-review.yml)
- [`.github/workflows/security.yml`](./.github/workflows/security.yml)

On every push and pull request:

- install Node.js 22 dependencies with `npm ci`
- run `npm test`

On pushes to `main` and pull requests targeting `main`:

- run CodeQL static analysis
- run dependency and container vulnerability checks

On pushes:

- build the Docker image
- push it to GitHub Container Registry
- publish branch, SHA, and tag-based image tags

On pull requests:

- Dependency Review blocks newly introduced vulnerable dependencies at moderate severity or higher.

On a weekly schedule:

- Dependabot checks npm, Docker, and GitHub Actions updates.
- CodeQL re-runs static analysis.
- `npm audit` checks dependency advisories.
- Trivy scans the repository filesystem and Docker image, then uploads SARIF results to GitHub code scanning.

Version tags are published as matching image tags. For example, `v0.1.0` is published as:

```text
ghcr.io/tech-grandpa/codex-sub-proxy:v0.1.0
```

The default branch also publishes `latest`.

## Troubleshooting

`401 Unauthorized`

- Set `PROXY_API_KEY` in the server environment.
- Send `Authorization: Bearer ${PROXY_API_KEY}` from the client.

`502 upstream_error`

- Re-run the login helper if credentials may be expired.
- Confirm `CODEX_RESPONSES_PATH=/responses`.
- Confirm the account has Codex access.
- Check whether ChatGPT changed the private backend route or request contract.

Docker cannot bind port `3000`

- Another process is already listening on that port.
- Stop it or map a different host port, for example `-p 3001:3000`.

## Security

- Never commit `.env` or real OAuth credentials.
- Treat `OPENAI_REFRESH_TOKEN` like a password.
- Keep this service on private networks.
- Set `PROXY_API_KEY` for every non-local deployment.
- Avoid logging prompts, completions, API keys, or OAuth tokens.

## License

Apache-2.0
