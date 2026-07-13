#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-https://veronica.ariobarin.com}"

health="$(curl --fail --silent --show-error "${base_url}/healthz")"
if [[ "$health" != *'"ok":true'* || "$health" != *'"service":"veronica"'* ]]; then
  printf 'Unexpected health response: %s\n' "$health" >&2
  exit 1
fi

metadata="$(curl --fail --silent --show-error "${base_url}/.well-known/oauth-protected-resource")"
if [[ "$metadata" != *'"resource":"https://veronica.ariobarin.com/"'* || \
  "$metadata" != *'"authorization_servers"'* || \
  "$metadata" != *'"veronica:read"'* || \
  "$metadata" != *'"veronica:write"'* ]]; then
  printf 'Unexpected OAuth resource metadata: %s\n' "$metadata" >&2
  exit 1
fi

headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT
status="$(curl --silent --dump-header "$headers" --output /dev/null --write-out '%{http_code}' \
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
if ! grep -Eiq '^www-authenticate: Bearer .*scope="veronica:read veronica:write".*resource_metadata="https://veronica\.ariobarin\.com/\.well-known/oauth-protected-resource"' "$headers"; then
  printf '%s\n' 'OAuth bearer challenge is missing scopes or resource metadata' >&2
  exit 1
fi

printf 'Veronica public routing and authentication checks passed for %s\n' "$base_url"
