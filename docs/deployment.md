# Deploy Veronica

This guide describes the supported production boundary without assuming a particular hosting provider, domain, identity provider, reverse proxy, or CI system.

## Target architecture

Use one gateway host with a public HTTPS reverse proxy and a private network interface:

```text
external MCP client -> https://veronica.example.com/mcp -> reverse proxy -> 127.0.0.1:39100
enrolled worker -> private network -> http://10.20.0.1:39100/device/*
```

The gateway process listens only on loopback and the gateway private address. The reverse proxy publishes the MCP endpoint, health endpoint, and OAuth protected resource metadata. It never publishes worker routes. Port `39100` has no public firewall rule, port forward, tunnel, or DNAT rule.

WireGuard is the recommended private network because it works across ordinary NAT and has a small operational surface. Another operator controlled private network is acceptable when it preserves the same boundary.

## Choose deployment values

Define these values before installing anything:

| Purpose | Example |
| --- | --- |
| Public MCP origin | `https://veronica.example.com` |
| OAuth resource and JWT audience | `https://veronica.example.com/` |
| OAuth issuer | `https://identity.example.com/` |
| Gateway loopback address | `127.0.0.1` |
| Gateway private address | `10.20.0.1` |
| Gateway port | `39100` |
| Worker name | `laptop` |
| Exposed worker root | `/home/user/code` |

Keep the public origin and OAuth resource distinct where the trailing slash matters. Veronica uses the exact OAuth resource as the JWT audience.

## Configure the identity provider

Create one API or protected resource with the permission `veronica:access`.

Existing deployments that issued only `veronica:read` and `veronica:write` must create and grant `veronica:access` before deploying this revision. Existing access tokens are not rewritten; obtain a fresh token after updating the client grant and user authorization.

Veronica accepts access tokens that meet all of these conditions:

- JWT signed with RS256
- Exact configured issuer
- Exact configured audience
- Unexpired `exp` claim
- Client identifier in `client_id`, `azp`, or `sub`
- `veronica:access` in the space separated `scope` claim or the `permissions` array

The provider must publish a JWKS endpoint over HTTPS. Veronica uses `<issuer>/.well-known/jwks.json` unless `VERONICA_OAUTH_JWKS_URI` is set.

Remote MCP clients commonly use authorization code with PKCE. Some clients also require dynamic client registration or Client ID Metadata Document registration. Enable only the registration features required by the intended client, and grant the client and user the `veronica:access` permission.

Do not configure an OAuth client secret in Veronica. The gateway validates access tokens but does not act as an OAuth client.

## Install the gateway

Create a dedicated unprivileged user and release directories on the Linux gateway:

```bash
sudo useradd --system --home /var/lib/veronica --create-home --shell /usr/sbin/nologin veronica
sudo install -d -o veronica -g veronica /opt/veronica/releases
```

Clone and build a reviewed revision, then copy it into a revision named release directory:

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
VERONICA_OAUTH_ISSUER=https://identity.example.com/
VERONICA_OAUTH_RESOURCE=https://veronica.example.com/
HOSTS=127.0.0.1,10.20.0.1
PORT=39100
VERONICA_ALLOWED_HOSTS=veronica.example.com,10.20.0.1,127.0.0.1,localhost
```

Verify that the process runs as `veronica`, the environment file is mode `600`, and listener output contains only the approved addresses.

## Configure the private network

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

## Configure public HTTPS

Create the public DNS record and configure the existing reverse proxy if it can be changed safely. Preserve every existing listener and route.

The public virtual host must:

- Proxy `/mcp` to `http://127.0.0.1:39100`
- Proxy `/healthz` to `http://127.0.0.1:39100`
- Proxy `/.well-known/oauth-protected-resource` to `http://127.0.0.1:39100`
- Return `404` for `/device/*`
- Return `404` for other unneeded paths

Validate the complete proxy configuration before reload. Capture critical existing route behavior before and after the change.

A managed tunnel may publish the three public paths only when integrating the existing reverse proxy would create material risk. It must never publish `/device/*` or make port `39100` public. Inspect any existing tunnel before modifying or deleting it.

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

From outside the private network:

```bash
./scripts/remote-health-check.sh https://veronica.example.com
```

Also prove that a direct connection to the gateway public address on port `39100` fails. Complete the authenticated and recovery checks in [deployment-acceptance.md](deployment-acceptance.md).

## Upgrade and roll back

Build and test each new revision in a new release directory. Change the `current` symlink atomically, restart Veronica, and repeat private and public health checks. Keep several known good releases.

To roll back, point `current` to a previous release, restart Veronica, and repeat the same checks. Restore the previous reverse proxy configuration if public routing changed.

The gateway stores devices, jobs, and workspace leases in memory. Workers register again after a restart. A deployment must preserve `/etc/veronica.env` unless token rotation is intentional.

## Rotate and revoke access

Rotate the worker token by replacing `VERONICA_DEVICE_TOKEN`, restarting the gateway, and updating every enrolled worker. Confirm the old token receives `401` from `/device/*`.

Revoke MCP access in the identity provider. Do not expose access tokens, worker tokens, private keys, environment files, or logs containing credentials through CI artifacts or support records.

## Security limits

The prototype uses OAuth for MCP clients and one shared bearer token for workers. It has no database, rate limiting, per-device identity, local approval prompt, or durable audit log. Shell commands run with the worker account permissions and environment. Expose narrow roots and use a container or virtual machine for untrusted repositories.

Environment-specific procedures should live with the private infrastructure that owns them, not in this public runtime repository.
