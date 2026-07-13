# Deploy Veronica

The production gateway runs as one Node.js process on the Ariobarin VPS. It listens only on `127.0.0.1:39100` and the Relay WireGuard address `10.0.0.1:39100`.

Traffic is split by trust boundary:

```text
external MCP client -> https://veronica.ariobarin.com/mcp -> Relay Caddy -> 127.0.0.1:39100
enrolled workstation -> WireGuard -> http://10.0.0.1:39100/device/*
```

Relay Caddy also publishes `/healthz`. It returns `404` for public `/device/*` requests. Port `39100` is not bound to the public interface and must not have a public firewall or DNAT rule. Cloudflare Tunnel is not used for worker traffic.

## Deployment layout

```text
/opt/veronica/releases/<git-sha>
/opt/veronica/current -> /opt/veronica/releases/<git-sha>
/etc/veronica.env
/etc/systemd/system/veronica.service
/var/lib/veronica
```

The `veronica` system user runs the gateway. `/etc/veronica.env` is owned by root with mode `600`. The deployment workflow creates a random production token only when that file does not exist. Subsequent deploys preserve the token while enforcing the approved listener and host configuration.

## Public routing

The existing Relay Caddy process keeps its layer 4 SNI routes for other services. The Veronica SNI route forwards TLS to a loopback-only HTTPS listener in the same Caddy process, which proxies only `/mcp` and `/healthz` to the gateway.

`veronica.ariobarin.com` must have a DNS-only A record for the Relay VPS public address before deployment. Caddy obtains and renews the certificate. Do not enable Cloudflare proxying unless the certificate strategy is deliberately revised and validated.

An interrupted earlier setup may have installed the `cloudflared` package. An installed package alone is not an active tunnel. Before changing it, inspect its service, configuration, origin certificate, and tunnel credentials. The verified Relay state had no service unit, configuration, origin certificate, or tunnel credentials, so the package is retained but unused.

## Deploy

Run the `Deploy Veronica` workflow in `ariobarin/relay`.

1. Use `inspect` to capture the current WireGuard, Caddy, gateway, and cloudflared state.
2. Use `validate` to validate the repository Caddyfile with the VPS Caddy binary without installing it.
3. Create the DNS-only A record after validation succeeds.
4. Use `deploy` with the intended Veronica Git ref.

The workflow builds and checks Veronica, installs the pinned Node.js runtime, uploads a release, changes the `current` symlink atomically, restarts the gateway, installs the validated Caddy configuration, and reloads Caddy. It refuses to replace a live Caddyfile that does not match repository history. Gateway or Caddy health failures trigger rollback.

The workflow can be rerun for the same commit. It preserves `/etc/veronica.env`, reuses the release, and keeps the five newest releases.

## Retrieve the token securely

When direct VPS SSH is unavailable, use the Relay `Deploy Veronica` workflow with the `export-token` operation. Generate a one-time RSA key pair on the requesting workstation and submit only the base64-encoded public key. The workflow encrypts the production token on the VPS with RSA OAEP and SHA-256, then publishes the encrypted value as a one-day artifact. Decrypt it locally, store it in a protected environment or secret store, and delete the encrypted artifact plus both one-time key files.

The private key must never enter GitHub, workflow inputs, logs, pull requests, issues, or chat. The workflow must never print or upload the plaintext token.

Direct retrieval remains available in a trusted terminal with VPS access:

```bash
ssh root@VPS_HOST "sed -n 's/^VERONICA_TOKEN=//p' /etc/veronica.env"
```

Do not place the plaintext token in Git, GitHub Actions output, pull requests, issues, or chat.

## Connect a workstation

Connect the workstation to the existing Relay WireGuard network first. Install the same Veronica revision, set `VERONICA_TOKEN` from the protected local source, and expose the smallest useful directory:

```powershell
$env:VERONICA_TOKEN = "<production token from a protected source>"
npm run dev -- expose "C:\Users\Administrator\Desktop\repos" `
  --name desktop `
  --gateway "http://10.0.0.1:39100"
```

The worker uses WireGuard for every `/device/*` request. It must not use the public hostname. Stopping the process removes the workstation connection.

## Verify

On the VPS:

```bash
systemctl is-active veronica
systemctl is-active caddy
curl --fail --silent --show-error http://127.0.0.1:39100/healthz
curl --fail --silent --show-error http://10.0.0.1:39100/healthz
ss -ltnp | grep ':39100'
```

The listener output must include only `127.0.0.1:39100` and `10.0.0.1:39100`. It must not include `0.0.0.0:39100` or the VPS public address.

From an external machine:

```bash
./scripts/remote-health-check.sh
```

An authenticated MCP smoke test must list the workstation, open a workspace, read and write a disposable file, run a harmless command, close the workspace, and remove the disposable file. Run the full checklist in [deployment-acceptance.md](deployment-acceptance.md).

## Operate

Restart the gateway with:

```bash
systemctl restart veronica
```

Workers retry after connection errors and register again after the gateway loses its in-memory device state.

Rotate the token by replacing `VERONICA_TOKEN` in `/etc/veronica.env`, restarting Veronica, and updating each authorized client. Verify that the old token receives `401` before considering rotation complete.

Roll back by selecting a prior directory under `/opt/veronica/releases`, changing the `current` symlink atomically, restarting Veronica, and checking both private listener addresses plus public health. Restore the prior repository Caddyfile and reload Caddy if public routing changed. The Relay workflow performs these rollbacks automatically when a deployment fails verification.

## Security limits

The prototype uses one shared bearer token and has no database, rate limiting, per-device identity, approval prompt, or durable audit log. Shell commands run with the workstation user's permissions and environment. Expose narrow roots, use a dedicated workstation account for unattended access, and use a container or virtual machine for untrusted repositories.
