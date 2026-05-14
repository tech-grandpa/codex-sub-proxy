#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ENV_FILE="${ENV_FILE:-.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if [ -z "${PROXY_API_KEY:-}" ]; then
  echo "PROXY_API_KEY is required in the environment or ${ENV_FILE}" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

request() {
  name="$1"
  expected="$2"
  shift 2
  status_file="${tmp_dir}/${name}.status"
  body_file="${tmp_dir}/${name}.body"

  status="$(curl -sS -o "$body_file" -w "%{http_code}" "$@")"
  printf "%s" "$status" > "$status_file"

  if [ "$status" != "$expected" ]; then
    echo "FAIL ${name}: expected HTTP ${expected}, got ${status}" >&2
    cat "$body_file" >&2
    exit 1
  fi

  echo "ok ${name}: HTTP ${status}"
}

request "healthz" "200" "${BASE_URL}/healthz"

request "models-unauthorized" "401" "${BASE_URL}/v1/models"

request "models" "200" \
  "${BASE_URL}/v1/models" \
  -H "Authorization: Bearer ${PROXY_API_KEY}"

request "chat-completions" "200" \
  "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [
      { "role": "system", "content": "Reply with exactly one short sentence." },
      { "role": "user", "content": "Say that chat completions passed." }
    ]
  }'

request "responses" "200" \
  "${BASE_URL}/v1/responses" \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "instructions": "Reply with exactly one short sentence.",
    "input": "Say that Responses passed."
  }'

request "streaming-rejected" "501" \
  "${BASE_URL}/v1/responses" \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "stream": true,
    "input": "Say ok."
  }'

echo "smoke test passed"
