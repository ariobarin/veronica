# Ariobarin deployment notes

This file records the maintainer deployment for development and recovery work. It is intentionally specific to the Ariobarin environment. It contains no credentials and is not a template for other installations.

Last verified: 2026-07-13

## Repositories and revisions

- Veronica: `ariobarin/veronica`
- Relay infrastructure: `ariobarin/relay`
- Veronica deployment change: pull request 6, merge commit `a98afa7c1129bd074bca76524113d643a0403f41`
- Relay deployment change: pull request 6, merge commit `77414440e6baec3a836a5eb3d024f658282c9db2`
- Relay inspection logging: pull request 7, merge commit `4caa09c9dead5e5e6665770bd7ebe67a5a0e8532`

Local development checkouts live below `C:\Users\Administrator\Desktop\repos`.

## Network and routing

```text
external MCP client -> https://veronica.ariobarin.com/mcp -> Relay Caddy -> 127.0.0.1:39100
enrolled workstation -> Relay WireGuard -> http://10.0.0.1:39100/device/*
```

Current values:

- Public origin: `https://veronica.ariobarin.com`
- VPS public address: `107.174.80.179`
- VPS WireGuard address: `10.0.0.1`
- Gateway listeners: `127.0.0.1:39100` and `10.0.0.1:39100`
- Worker gateway URL: `http://10.0.0.1:39100`
- Workstation device name: `desktop`
- Workstation exposed root: `C:\Users\Administrator\Desktop\repos`

Port `39100` has no public listener, firewall rule, forward, or DNAT rule. Public `/device/*` requests return `404`.

The existing Relay Caddy process retains its layer 4 SNI routes. Veronica uses a hostname specific SNI route that terminates at a loopback Caddy HTTPS listener, then proxies only `/mcp`, `/healthz`, and `/.well-known/oauth-protected-resource` to the gateway.

The `cloudflared` package is installed on the VPS but unused. The last inspection found no service unit, configuration, origin certificate, or tunnel credential files. Do not delete or reconfigure it without repeating that inspection.

## VPS layout

```text
/opt/veronica/releases/<git-sha>
/opt/veronica/current -> /opt/veronica/releases/<git-sha>
/etc/veronica.env
/etc/systemd/system/veronica.service
/var/lib/veronica
```

The gateway runs as the `veronica` system user. `/etc/veronica.env` is owned by root with mode `600`. Caddy and Veronica are enabled systemd services.

Approved environment shape:

```dotenv
VERONICA_OAUTH_ISSUER=https://dev-fl2h5xhp6umeh74m.us.auth0.com/
VERONICA_OAUTH_AUDIENCE=https://veronica.ariobarin.com/
VERONICA_OAUTH_RESOURCE=https://veronica.ariobarin.com/
HOSTS=127.0.0.1,10.0.0.1
PORT=39100
VERONICA_ALLOWED_HOSTS=veronica.ariobarin.com,10.0.0.1,127.0.0.1,localhost
```

`VERONICA_DEVICE_TOKEN` also exists in the environment file but must never be copied into this repository, a workflow input, logs, issues, pull requests, or chat.

## Auth0 and ChatGPT

Auth0 tenant:

- Issuer: `https://dev-fl2h5xhp6umeh74m.us.auth0.com/`
- API identifier: `https://veronica.ariobarin.com/`
- Signing algorithm: RS256
- Permissions: `veronica:read` and `veronica:write`
- RBAC: enabled
- Permissions in access tokens: enabled
- Resource Parameter Compatibility: enabled
- Client ID Metadata Document registration: enabled
- Dynamic client registration: enabled

ChatGPT uses this Client ID Metadata Document:

```text
https://chatgpt.com/oauth/8GVAEQJB-leg/client.json
```

Its imported Auth0 client ID is `tpc_aNu3zb62GrA4zYj4BnmK6v`. The client grant and the authorized user both need the two Veronica permissions. The Google connection must be enabled for this client.

The ChatGPT development app values are:

- App ID: `asdk_app_6a55421a9b948191a95175670a7a7976`
- Version ID: `asdk_app_v_6a55421c187c8191974a7a3349d2f717`
- MCP URL: `https://veronica.ariobarin.com/mcp`

The tenant currently uses Auth0 Google development keys. They are acceptable for testing but should be replaced with a dedicated Google OAuth application before broader production use.

## Deploy through Relay

Use the `Deploy Veronica` workflow in `ariobarin/relay`. It reuses the existing VPS deployment secret and supports these operations:

1. `inspect` captures WireGuard, listeners, firewall forwarding, Caddy, Veronica, and cloudflared state.
2. `validate` checks the repository Caddyfile with the installed VPS Caddy binary without installing it.
3. `deploy` builds the requested Veronica Git revision, uploads an atomic release, restarts Veronica, installs the validated Caddy configuration, and reloads Caddy.
4. `reboot` performs the controlled VPS reboot path.
5. `export-token` encrypts the worker token to a one-time RSA public key and publishes only encrypted output.

The workflow refuses to replace a live Caddyfile that does not match repository history. Failed gateway, OAuth metadata, or Caddy health checks trigger rollback. Repeated deployment of the same revision preserves `/etc/veronica.env` and the worker token.

Repository variable:

```text
VERONICA_OAUTH_ISSUER=https://dev-fl2h5xhp6umeh74m.us.auth0.com/
```

Known successful runs from the initial deployment:

- Deploy: `https://github.com/ariobarin/relay/actions/runs/29279918803`
- Post deployment inspect: `https://github.com/ariobarin/relay/actions/runs/29280073796`
- Main branch inspect with recent logs: `https://github.com/ariobarin/relay/actions/runs/29282323776`

## Retrieve the worker token

Prefer the Relay workflow `export-token` operation when direct VPS SSH is unavailable. Generate a one-time RSA key pair locally, submit only the base64 encoded public key, download the one-day encrypted artifact, decrypt locally, then delete the artifact and both key files.

Direct retrieval from a trusted VPS terminal remains available:

```bash
ssh root@107.174.80.179 "sed -n -e 's/^VERONICA_DEVICE_TOKEN=//p' -e 's/^VERONICA_TOKEN=//p' /etc/veronica.env | head -n 1"
```

Never paste the returned value into chat or GitHub.

## Start the workstation worker

Connect Windows to the `wg-relay` WireGuard tunnel, load the token from its protected local source, and start the worker from the matching Veronica revision:

```powershell
$env:VERONICA_TOKEN = "<protected token>"
npm run dev -- expose "C:\Users\Administrator\Desktop\repos" `
  --name desktop `
  --gateway "http://10.0.0.1:39100"
```

After the 2026-07-13 Windows reboot, ChatGPT `list_devices` returned exactly `desktop`, proving that the worker and WireGuard path recovered. Preserve the local startup mechanism when changing worker installation.

## Acceptance checks

Run the generic checklist in [deployment-acceptance.md](deployment-acceptance.md) with these substitutions:

- `https://veronica.example.com` becomes `https://veronica.ariobarin.com`
- `10.20.0.1` becomes `10.0.0.1`
- Worker name becomes `desktop`

Public routing check:

```bash
./scripts/remote-health-check.sh https://veronica.ariobarin.com
```

Private Windows checks:

```powershell
Test-NetConnection 10.0.0.1 -Port 39100
Invoke-RestMethod http://10.0.0.1:39100/healthz
```

The authenticated ChatGPT smoke test must attach Veronica to the conversation, call only `list_devices`, and return `desktop`. For a full acceptance pass, continue with a disposable workspace file and harmless working directory command as described in the generic checklist.

## Recovery notes

Restart the gateway with `systemctl restart veronica`. Workers register again because gateway state is in memory.

For application rollback, select a prior directory under `/opt/veronica/releases`, change the `current` symlink atomically, restart Veronica, and repeat both listener and public checks. Restore the prior Relay Caddyfile and reload Caddy if routing changed. Prefer the Relay workflow because it automates these checks and rollback conditions.
