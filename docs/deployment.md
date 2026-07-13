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

The `veronica` system user runs the gateway. `/etc/veronica.env` is owned by root with mode `600`. The deployment workflow creates a random production device token only when that file does not exist. Subsequent deploys preserve the token while enforcing the approved listener, host, and OAuth resource configuration.

## Public routing

The existing Relay Caddy process keeps its layer 4 SNI routes for other services. The Veronica SNI route forwards TLS to a loopback-only HTTPS listener in the same Caddy process, which proxies only `/mcp`, `/healthz`, and `/.well-known/oauth-protected-resource` to the gateway.

`veronica.ariobarin.com` must have a DNS-only A record for the Relay VPS public address before deployment. Caddy obtains and renews the certificate. Do not enable Cloudflare proxying unless the certificate strategy is deliberately revised and validated.

An interrupted earlier setup may have installed the `cloudflared` package. An installed package alone is not an active tunnel. Before changing it, inspect its service, configuration, origin certificate, and tunnel credentials. The verified Relay state had no service unit, configuration, origin certificate, or tunnel credentials, so the package is retained but unused.

## OAuth identity provider

The production authorization server is an established OAuth 2.1 identity provider. Configure one API or resource with the exact identifier `https://veronica.ariobarin.com/` and the permissions `veronica:read` and `veronica:write`. Enable authorization code flow with PKCE, Client ID Metadata Document registration, and RFC 8707 resource parameter compatibility. Ensure the intended user connection can grant both permissions.

For Auth0, create the API with RS256 signing, add both permissions, enable RBAC plus permissions in access tokens, then enable Client ID Metadata Document Registration and Resource Parameter Compatibility Profile under tenant advanced settings. Set the Relay repository variable `VERONICA_OAUTH_ISSUER` to the tenant issuer URL, including its trailing slash. The audience and resource are fixed by the deployment workflow.

Do not store an Auth0 client secret in Veronica. ChatGPT registers as a public OAuth client and uses authorization code flow with PKCE.

## Deploy

Run the `Deploy Veronica` workflow in `ariobarin/relay`.

1. Use `inspect` to capture the current WireGuard, Caddy, gateway, and cloudflared state.
2. Use `validate` to validate the repository Caddyfile with the VPS Caddy binary without installing it.
3. Create the DNS-only A record after validation succeeds.
4. Use `deploy` with the intended Veronica Git ref.

The workflow builds and checks Veronica, validates the configured OAuth issuer, installs the pinned Node.js runtime, uploads a release, changes the `current` symlink atomically, restarts the gateway, installs the validated Caddy configuration, and reloads Caddy. It refuses to replace a live Caddyfile that does not match repository history. Gateway, OAuth metadata, or Caddy health failures trigger rollback.

The workflow can be rerun for the same commit. It preserves `/etc/veronica.env`, reuses the release, and keeps the five newest releases.

## Retrieve the device token securely

When direct VPS SSH is unavailable, use the Relay `Deploy Veronica` workflow with the `export-token` operation. Generate a one-time RSA key pair on the requesting workstation and submit only the base64-encoded public key. The workflow encrypts the production device token on the VPS with RSA OAEP and SHA-256, then publishes the encrypted value as a one-day artifact. Decrypt it locally, store it in a protected environment or secret store, and delete the encrypted artifact plus both one-time key files.

The private key must never enter GitHub, workflow inputs, logs, pull requests, issues, or chat. The workflow must never print or upload the plaintext token.

Direct retrieval remains available in a trusted terminal with VPS access. Existing deployments may retain the legacy variable name during migration:

```bash
ssh root@VPS_HOST "sed -n -e 's/^VERONICA_DEVICE_TOKEN=//p' -e 's/^VERONICA_TOKEN=//p' /etc/veronica.env | head -n 1"
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

Rotate the device token by replacing `VERONICA_DEVICE_TOKEN` in `/etc/veronica.env`, restarting Veronica, and updating each enrolled worker. Verify that the old token receives `401` on `/device/*` before considering rotation complete. Revoke MCP access through the identity provider.

Roll back by selecting a prior directory under `/opt/veronica/releases`, changing the `current` symlink atomically, restarting Veronica, and checking both private listener addresses plus public health. Restore the prior repository Caddyfile and reload Caddy if public routing changed. The Relay workflow performs these rollbacks automatically when a deployment fails verification.

## Security limits

The prototype uses OAuth for MCP clients and one shared bearer token for workers. It has no database, rate limiting, per-device identity, local approval prompt, or durable audit log. Shell commands run with the workstation user's permissions and environment. Expose narrow roots, use a dedicated workstation account for unattended access, and use a container or virtual machine for untrusted repositories.
