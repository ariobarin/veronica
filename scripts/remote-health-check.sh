#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-}"
if [[ -z "$base_url" ]]; then
  printf '%s\n' 'Usage: remote-health-check.sh https://veronica.example.com' >&2
  exit 2
fi
base_url="${base_url%/}"

health="$(curl --fail --silent --show-error "${base_url}/healthz")"
if [[ "$health" != *'"ok":true'* || "$health" != *'"service":"veronica"'* ]]; then
  printf 'Unexpected health response: %s\n' "$health" >&2
  exit 1
fi

status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST \
  --header 'content-type: application/json' \
  --data '{}' \
  "${base_url}/device/register")"
if [[ "$status" != "404" ]]; then
  printf 'Expected the remote device route to return 404, got %s\n' "$status" >&2
  exit 1
fi

status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST \
  --header 'accept: application/json, text/event-stream' \
  --header 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"veronica-health-check","version":"1.0.0"}}}' \
  "${base_url}/mcp")"
if [[ "$status" != "200" ]]; then
  printf 'Expected MCP initialize to return 200, got %s\n' "$status" >&2
  exit 1
fi

printf 'Veronica remote routing checks passed for %s\n' "$base_url"
