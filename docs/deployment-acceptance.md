# Deployment acceptance

Run this checklist after the first deployment, after authentication or routing changes, and before declaring recovery work complete. Record the deployed Veronica revision, infrastructure revision, gateway addresses, public origin, and test time.

Replace the example values below with the deployment values.

## Gateway boundary

On the gateway, confirm Veronica is active and bound only to loopback and the private network:

```bash
systemctl is-active veronica
ss -ltnp | grep ':39100'
curl --fail http://127.0.0.1:39100/healthz
curl --fail http://10.20.0.1:39100/healthz
```

Pass criteria:

- `127.0.0.1:39100` and the configured private address are listening.
- `0.0.0.0:39100`, `[::]:39100`, and the gateway public address on port `39100` are absent.
- No public firewall, port forward, proxy, tunnel, or DNAT rule exposes port `39100`.
- The reverse proxy and private network services are active.
- Any managed tunnel has no worker route.

## Existing public routes

If the reverse proxy serves other applications, capture their critical handshake and health results before and after the Veronica change. Every route that worked before the reload must still work afterward. Validate the complete proposed proxy configuration with the installed production binary before reload.

## Public route

Run from outside the gateway private network:

```bash
./scripts/remote-health-check.sh https://veronica.example.com
```

Pass criteria:

- `/healthz` returns the Veronica health document over valid HTTPS.
- `/.well-known/oauth-protected-resource` identifies the configured resource, authorization server, and the supported scope.
- Unauthenticated `/mcp` returns `401` with the required scopes and `resource_metadata` in `WWW-Authenticate`.
- `/device/register` returns `404`.
- A direct connection to the gateway public address on port `39100` fails.

## Worker route

Connect the worker to the private network and verify reachability:

```bash
curl --fail http://10.20.0.1:39100/healthz
```

On Windows PowerShell:

```powershell
Test-NetConnection 10.20.0.1 -Port 39100
Invoke-RestMethod http://10.20.0.1:39100/healthz
```

Start the worker with its private gateway URL and confirm `list_devices` returns its exact name. The worker must not use the public MCP hostname.

## OAuth token boundary

Inspect claims without recording the token itself. Confirm:

- Signature algorithm is RS256.
- Issuer exactly matches `VERONICA_OAUTH_ISSUER`.
- Audience exactly matches `VERONICA_OAUTH_RESOURCE`.
- `exp` is present and current.
- `veronica:access` appears in `scope` or `permissions`.
- A client identifier appears in `client_id`, `azp`, or `sub`.

The worker token must fail on `/mcp`. An OAuth access token must fail on `/device/register`, `/device/poll`, and `/device/result`.

## Authenticated MCP flow

Connect the public `/mcp` URL in an OAuth capable MCP client. Complete login and consent, then:

1. List devices and find the intended worker.
2. Open a workspace below its exposed root.
3. Read a known non-sensitive text file.
4. Write a uniquely named disposable text file.
5. Read back the exact content.
6. Run a harmless command that reports the working directory.
7. Remove the disposable file.
8. Close the workspace.

Do not include access tokens, worker tokens, private keys, or sensitive file contents in the test record.

## Recovery and idempotency

Restart Veronica while the worker is running. The worker must reconnect and appear in `list_devices` without manual reconfiguration. Repeat the same deployment for the same revision and confirm it succeeds without rotating the worker token or widening listener scope.

When operationally safe, reboot the gateway and one worker. Confirm private networking, the reverse proxy, Veronica, and the worker return automatically. Repeat private health, public routing, existing route, and authenticated MCP checks after the reboot.
