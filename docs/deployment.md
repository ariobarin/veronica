# Deploy Veronica

The production gateway runs as one Node.js process on the Ariobarin VPS. It binds to `127.0.0.1:39100` and Cloudflare Tunnel publishes `https://veronica.ariobarin.com`. The VPS routes requests but does not run workstation commands.

## Deployment layout

```text
/opt/veronica/releases/<git-sha>
/opt/veronica/current -> /opt/veronica/releases/<git-sha>
/etc/veronica.env
/etc/systemd/system/veronica.service
/var/lib/veronica
```

The `veronica` system user runs the gateway. `/etc/veronica.env` is owned by root with mode `600`. The deployment workflow creates a random production token only when that file does not exist.

## Deploy

Run the `Deploy Veronica` workflow in `ariobarin/relay`. Choose the Veronica Git ref, then enable tunnel configuration only when the named Cloudflare Tunnel has not been configured yet. The workflow builds and checks Veronica, installs the pinned Node.js runtime, uploads a release, changes the `current` symlink atomically, restarts the service, and rolls back if local health verification fails.

The first tunnel configuration runs `cloudflared tunnel login`. Complete the browser authentication without copying Cloudflare credentials into chat or workflow inputs. The workflow then creates the `veronica` tunnel, adds the DNS route, installs its configuration, and starts `cloudflared`.

The workflow can be rerun for the same commit. It preserves `/etc/veronica.env`, reuses the release, and keeps the five newest releases.

## Retrieve the token

Retrieve the production token only in a trusted terminal with VPS access:

```bash
ssh root@VPS_HOST "sed -n 's/^VERONICA_TOKEN=//p' /etc/veronica.env"
```

Store it in a protected local environment or secret store. Do not place it in Git, GitHub Actions output, pull requests, issues, or chat.

## Connect a workstation

Install the same Veronica revision, set `VERONICA_TOKEN` from the protected local source, and expose the smallest useful directory:

```powershell
$env:VERONICA_TOKEN = "<production token from a protected source>"
npm run dev -- expose "C:\Users\Administrator\Desktop\repos" `
  --name desktop `
  --gateway "https://veronica.ariobarin.com"
```

Stopping this process removes the workstation connection.

## Verify

On the VPS:

```bash
systemctl is-active veronica
systemctl is-active cloudflared
curl --fail --silent --show-error http://127.0.0.1:39100/healthz
ss -ltnp | grep '127.0.0.1:39100'
```

From an external machine:

```bash
./scripts/remote-health-check.sh
```

An authenticated MCP smoke test must list the workstation, open a workspace, read and write a file, run a harmless command, and close the workspace.

## Operate

Restart the gateway with:

```bash
systemctl restart veronica
```

Workers retry after connection errors and register again after the gateway loses its in-memory device state.

Rotate the token by replacing `VERONICA_TOKEN` in `/etc/veronica.env`, restarting Veronica, and updating each authorized client. Verify that the old token receives `401` before considering rotation complete.

Roll back by selecting a prior directory under `/opt/veronica/releases`, changing the `current` symlink atomically, restarting Veronica, and checking both local and public health. The Relay workflow performs this rollback automatically when a new release fails its local health check.

## Security limits

The prototype uses one shared bearer token and has no database, rate limiting, per-device identity, approval prompt, or durable audit log. Shell commands run with the workstation user's permissions and environment. Expose narrow roots, use a dedicated workstation account for unattended access, and use a container or virtual machine for untrusted repositories.
