# Deployment acceptance

Run this checklist after the first deployment, after routing changes, and before declaring recovery work complete. Record the deployed Veronica commit and Relay commit with the results.

## Network boundary

On the VPS, confirm the gateway is active and bound only to loopback and WireGuard:

```bash
systemctl is-active veronica
ss -ltnp | grep ':39100'
curl --fail http://127.0.0.1:39100/healthz
curl --fail http://10.0.0.1:39100/healthz
```

Pass criteria:

- `127.0.0.1:39100` and `10.0.0.1:39100` are listening.
- `0.0.0.0:39100`, `[::]:39100`, and the VPS public address on port `39100` are absent.
- No public DNAT or firewall forwarding rule exposes port `39100`.
- The Caddy and WireGuard services are active.
- cloudflared has no active worker route.

## Existing Caddy routes

Capture TLS handshake results for the existing `play.ariobarin.com` and `pet.ariobarin.com` SNI routes before and after the change. A route that works before the reload must still work after it. Validate the proposed Caddyfile with the installed VPS binary before reloading it.

## Public route

Run from outside the Relay WireGuard network:

```bash
./scripts/remote-health-check.sh https://veronica.ariobarin.com
```

Pass criteria:

- `/healthz` returns the Veronica health document over valid HTTPS.
- unauthenticated `/mcp` returns `401`.
- `/device/register` returns `404`, proving worker routes are not public.
- a direct connection to public port `39100` fails.

## Workstation route

Connect the workstation to Relay WireGuard and verify private reachability:

```powershell
Test-NetConnection 10.0.0.1 -Port 39100
Invoke-RestMethod http://10.0.0.1:39100/healthz
```

Start the worker with `--gateway "http://10.0.0.1:39100"`. Confirm that the gateway lists the enrolled workstation. The worker must not use `https://veronica.ariobarin.com`.

## Authenticated MCP flow

Using the production token through `https://veronica.ariobarin.com/mcp`:

1. List devices and find the workstation.
2. Open a workspace below its exposed root.
3. Read a known text file.
4. Write a uniquely named disposable text file.
5. Read back the exact content.
6. Run a harmless command that reports the working directory.
7. Remove the disposable file.
8. Close the workspace.

Do not include the production token or sensitive file contents in the test record.

## Recovery and idempotency

Restart Veronica while the worker is running. The worker must reconnect and appear in `list_devices` without manual reconfiguration. Repeat the same deployment for the same commit and confirm it succeeds without rotating the token or changing listener scope.

When operationally safe, reboot the VPS and confirm WireGuard, Caddy, and Veronica return automatically. Repeat private health, public routing, existing SNI route, and authenticated MCP checks after the reboot.
