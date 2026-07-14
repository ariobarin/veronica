# Deployment acceptance

Run this checklist after the first deployment, after access-control or routing changes, and before declaring recovery work complete. Record the deployed Veronica revision, infrastructure revision, gateway addresses, MCP origin, transport type, and test time.

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
- No public firewall, port forward, proxy, tunnel, or DNAT rule exposes port `39100` directly.
- The trusted MCP transport and private worker network are active.
- Any managed tunnel has no worker route.

## Existing routes

If the reverse proxy or tunnel serves other applications, capture their critical handshake and health results before and after the Veronica change. Every route that worked before the reload must still work afterward. Validate the complete proposed configuration with the installed production binary before reload.

## MCP transport boundary

From the intended client path, run:

```bash
./scripts/remote-health-check.sh https://veronica.example.com
```

Pass criteria:

- `/healthz` returns the Veronica health document over valid HTTPS when that route is exposed.
- A valid MCP `initialize` request reaches `/mcp` and returns `200` without an application authentication exchange.
- `/device/register` returns `404` through the remote transport.
- A direct connection to the gateway public address on port `39100` fails.

Then test from a client that is not authorized by the surrounding transport. It must not reach `/mcp`. Record only the denial result, not credentials or private configuration.

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

Start the worker with its private gateway URL and confirm `list_devices` returns its exact name. The worker must not use the MCP transport hostname.

The worker token must receive `401` when absent or incorrect on `/device/register`, `/device/poll`, and `/device/result`. The correct token must succeed. The token is not required and is not treated as a client credential on `/mcp`.

## MCP tool metadata

List the MCP tools and confirm:

- `list_devices`, `open_workspace`, and `read_file` are read-only.
- `write_file` is not read-only and is destructive-capable.
- `run_command` is not read-only, is destructive-capable, and has open-world effects.
- `close_workspace` does not claim to modify workspace files.

Tool annotations are not authorization, but inaccurate annotations can bypass harness confirmation policy and are a release blocker.

## Functional MCP flow

Connect through the access-controlled MCP transport, then:

1. List devices and find the intended worker.
2. Open a workspace below its exposed root.
3. Read a known non-sensitive text file.
4. Write a uniquely named disposable text file.
5. Read back the exact content.
6. Run a harmless command that reports the working directory.
7. Remove the disposable file.
8. Close the workspace.

Do not include worker tokens, transport credentials, private keys, or sensitive file contents in the test record.

## Recovery and idempotency

Restart Veronica while the worker is running. The worker must reconnect and appear in `list_devices` without manual reconfiguration. Repeat the same deployment for the same revision and confirm it succeeds without rotating the worker token or widening listener scope.

When operationally safe, reboot the gateway and one worker. Confirm private networking, the trusted transport, Veronica, and the worker return automatically. Repeat private health, remote routing, existing route, transport denial, tool metadata, and functional MCP checks after the reboot.
