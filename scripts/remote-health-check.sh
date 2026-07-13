#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-https://veronica.ariobarin.com}"

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
  printf 'Expected the public device route to return 404, got %s\n' "$status" >&2
  exit 1
fi

status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST \
  --header 'content-type: application/json' \
  --data '{}' \
  "${base_url}/mcp")"
if [[ "$status" != "401" ]]; then
  printf 'Expected unauthenticated MCP access to return 401, got %s\n' "$status" >&2
  exit 1
fi

printf 'Veronica public routing and authentication checks passed for %s\n' "$base_url"
