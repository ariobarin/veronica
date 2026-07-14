# Deploy Veronica

This guide describes the supported production boundary without assuming a particular hosting provider, private network, reverse proxy, authenticated tunnel, or CI system.

## Target architecture

Use one gateway host with a private listener and an access-controlled transport for MCP clients:

```text
authorized MCP client -> access-controlled HTTPS transport -> http://127.0.0.1:39100/mcp
enrolled worker -> private network -> http://10.20.0.1:39100/device/*
```

The gateway process listens only on loopback and the gateway private address. The transport may publish `/mcp` and optionally `/healthz`, but it must authenticate or otherwise restrict the intended MCP clients. It never publishes worker routes. Port `39100` has no public firewall rule, port forward, tunnel, or DNAT rule.

WireGuard is the recommended worker network because it works across ordinary NAT and has a small operational surface. Another operator-controlled private network is acceptable when it preserves the same boundary.

## Choose deployment values

Define these values before installing anything:

| Purpose | Example |
| --- | --- |
| MCP origin presented by the trusted transport | `https://veronica.example.com` |
| Gateway loopback address | `127.0.0.1` |
| Gateway private address | `10.20.0.1` |
| Gateway port | `39100` |
| Worker name | `laptop` |
| Exposed worker root | `/home/user/code` |

Also choose how the trusted transport admits MCP clients. Acceptable examples include an authenticated private tunnel, a VPN restricted to the client, or a mutually authenticated reverse proxy. A plain anonymous public reverse proxy is not an access boundary.

## Install the gateway

Create a dedicated unprivileged user and release directories on the Linux gateway:

```bash
sudo useradd --system --home /var/lib/veronica --create-home --shell /usr/sbin/nologin veronica
sudo install -d -o veronica -g veronica /opt/veronica/releases
```

Clone and build a reviewed revision, then copy it into a revision-named release directory:

```bash
git clone https://github.com/ariobarin/veronica.git
cd veronica
git checkout <reviewed-commit-or-tag>
npm ci --ignore-scripts
npm run check
sudo cp -a . "/opt/veronica/releases/$(git rev-parse HEAD)"
sudo ln -sfn "/opt/veronica/releases/$(git rev-parse HEAD)" /opt/veronica/current
```

Production automation should build in a temporary directory, upload a complete release, and replace the `current` symlink atomically only after validation.

## Configure the gateway

Copy [deploy/veronica.env.example](../deploy/veronica.env.example) to `/etc/veronica.env`, replace every example value, and generate a random worker token:

```bash
openssl rand -hex 32
sudo chmod 600 /etc/veronica.env
sudo chown root:root /etc/veronica.env
```

Install [deploy/veronica.service](../deploy/veronica.service), then start the gateway:

```bash
sudo cp deploy/veronica.service /etc/systemd/system/veronica.service
sudo systemctl daemon-reload
sudo systemctl enable --now veronica
sudo systemctl status veronica
```

The environment should have this shape:

```dotenv
VERONICA_DEVICE_TOKEN=<random value with at least 32 characters>
HOSTS=127.0.0.1,10.20.0.1
PORT=39100
VERONICA_ALLOWED_HOSTS=veronica.example.com,10.20.0.1,127.0.0.1,localhost
```

`VERONICA_ALLOWED_HOSTS` limits accepted HTTP hostnames. It does not authenticate a client.

Verify that the process runs as `veronica`, the environment file is mode `600`, and listener output contains only the approved addresses.

## Configure the private worker network

Enroll each worker in WireGuard or the chosen private network. Allow worker peers to reach only the gateway private address and port needed for Veronica. Do not route the gateway public interface to port `39100`.

From each worker, verify private reachability before starting Veronica:

```bash
curl --fail http://10.20.0.1:39100/healthz
```

On Windows PowerShell:

```powershell
Test-NetConnection 10.20.0.1 -Port 39100
Invoke-RestMethod http://10.20.0.1:39100/healthz
```

## Configure the MCP transport

Configure the chosen trusted transport to reach `http://127.0.0.1:39100`. It may expose:

- `/mcp`
- `/healthz`, when operationally useful

It must return `404` for `/device/*` and any other unneeded path.

The transport must enforce its client boundary before forwarding `/mcp`. Confirm that an unauthorized client cannot reach the gateway, while the intended MCP client can. Do not rely on `VERONICA_ALLOWED_HOSTS`, obscurity, an unguessable URL, or TLS alone as authorization.

A managed tunnel is acceptable only when it provides the required client access control and publishes no worker route. Inspect any existing tunnel before modifying or deleting it.

Run the public or remote route check through the same access-controlled path used by the intended client:

```bash
./scripts/remote-health-check.sh https://veronica.example.com
```

## Connect workers

Install the same reviewed Veronica revision on the worker, run `npm link` once to install the CLI, retrieve the shared device token through a protected channel, and expose the smallest useful root:

```bash
cd /path/to/veronica
npm link
export VERONICA_TOKEN="<protected worker token>"
export VERONICA_GATEWAY="http://10.20.0.1:39100"
veronica expose "$HOME/code/project" --name laptop
```

Use a service manager or scheduled task if the worker must reconnect after reboot. Run it as a dedicated account when unattended access is required. The account permissions define what `run_command` can do.

## Verify

On the gateway:

```bash
systemctl is-active veronica
curl --fail http://127.0.0.1:39100/healthz
curl --fail http://10.20.0.1:39100/healthz
ss -ltnp | grep ':39100'
```

From the intended MCP client path:

```bash
./scripts/remote-health-check.sh https://veronica.example.com
```

Also prove all of the following:

- An unauthorized client cannot reach `/mcp` through the surrounding transport.
- A direct connection to the gateway public address on port `39100` fails.
- Public or remote `/device/*` routes return `404`.
- The worker reaches `/device/*` only through the private network.
- The write and command tools are presented as non-read-only and destructive-capable.

Complete the functional and recovery checks in [deployment-acceptance.md](deployment-acceptance.md).

## Upgrade and roll back

Build and test each new revision in a new release directory. Change the `current` symlink atomically, restart Veronica, and repeat private and remote health checks. Keep several known-good releases.

To roll back, point `current` to a previous release, restart Veronica, and repeat the same checks. Restore the previous transport configuration if routing changed.

The gateway stores devices, jobs, and workspace leases in memory. Workers register again after a restart. A deployment must preserve `/etc/veronica.env` unless worker-token rotation is intentional.

## Rotate and revoke access

Rotate the worker token by replacing `VERONICA_DEVICE_TOKEN`, restarting the gateway, and updating every enrolled worker. Confirm the old token receives `401` from `/device/*`.

Revoke MCP access in the surrounding transport. Veronica itself has no MCP client identity, session, or revocation database. Do not expose worker tokens, transport credentials, private keys, environment files, or logs containing credentials through CI artifacts or support records.

## Security limits

The prototype uses no built-in MCP client authentication and one shared bearer token for workers. It has no database, rate limiting, per-device identity, local approval prompt, or durable audit log. Shell commands run with the worker account permissions and environment. Expose narrow roots and use a container or virtual machine for untrusted repositories.

Environment-specific procedures should live with the private infrastructure that owns them, not in this public runtime repository.
