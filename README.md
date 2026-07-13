# Veronica

Veronica lets an agent use a directory on one of your computers as a remote coding workspace.

```text
agent -> OAuth protected MCP gateway -> private worker connection -> files and shell
```

The gateway exposes six MCP tools: `list_devices`, `open_workspace`, `read_file`, `write_file`, `run_command`, and `close_workspace`. The worker makes outbound requests only and exposes one directory chosen by its operator.

> Veronica is an early prototype. Commands run with the permissions and environment of the user who starts the worker. Read [SECURITY.md](SECURITY.md) before exposing a workstation.

## Quickstart

This quickstart uses one gateway host, one worker, a private network between them, and an HTTPS reverse proxy for MCP clients. Replace every `example.com`, address, path, and device name with values from your environment.

### 1. Prepare the required services

You need:

- Node.js 20 or newer on the gateway and worker
- An OAuth identity provider that issues RS256 JWT access tokens
- A Linux gateway host reachable by the worker through WireGuard or another operator controlled private network
- A public DNS name with HTTPS for remote MCP clients
- Git and a way to generate 32 random bytes, such as OpenSSL

Create an OAuth API or protected resource with:

- Resource and audience: `https://veronica.example.com/`
- Permissions: `veronica:read` and `veronica:write`
- Access tokens containing the permissions in either `scope` or `permissions`
- The exact issuer URL and a public JWKS endpoint
- Authorization code with PKCE for public clients

The access token must also contain `exp` and one client identifier in `client_id`, `azp`, or `sub`. If your MCP client uses dynamic registration or Client ID Metadata Documents, enable the matching feature in the identity provider.

### 2. Install Veronica

Run on both the gateway and worker:

```bash
git clone https://github.com/ariobarin/veronica.git
cd veronica
npm ci --ignore-scripts
npm run build
npm test
```

The package is currently private to the repository, so installation starts from a Git checkout rather than a registry package. On each worker, install the built CLI into npm's global command directory:

```bash
npm link
veronica --help
```

If `veronica` is not found, print the npm command directory with `npm prefix --global` and add that directory to `PATH`. On Windows, the default is `%APPDATA%\npm`; verify the installed shim with `where.exe veronica`. On Linux or macOS, use `command -v veronica`.

### 3. Start the gateway

Generate one worker token and protect it like a password:

```bash
export VERONICA_DEVICE_TOKEN="$(openssl rand -hex 32)"
```

Set the public OAuth identity and the private listener addresses:

```bash
export VERONICA_OAUTH_ISSUER="https://identity.example.com/"
export VERONICA_OAUTH_AUDIENCE="https://veronica.example.com/"
export VERONICA_OAUTH_RESOURCE="https://veronica.example.com/"
export HOSTS="127.0.0.1,10.20.0.1"
export PORT="39100"
export VERONICA_ALLOWED_HOSTS="veronica.example.com,10.20.0.1,127.0.0.1,localhost"
npm start
```

`VERONICA_OAUTH_AUDIENCE` must exactly match `VERONICA_OAUTH_RESOURCE`. Veronica obtains signing keys from `<issuer>/.well-known/jwks.json` by default. Set `VERONICA_OAUTH_JWKS_URI` when your provider publishes keys elsewhere.

Confirm both private listeners:

```bash
curl --fail http://127.0.0.1:39100/healthz
curl --fail http://10.20.0.1:39100/healthz
ss -ltnp | grep ':39100'
```

The output must not contain `0.0.0.0:39100`, `[::]:39100`, or the gateway public address.

### 4. Publish only the MCP surface

Configure your HTTPS reverse proxy so `https://veronica.example.com` forwards these paths to `http://127.0.0.1:39100`:

- `/mcp`
- `/healthz`
- `/.well-known/oauth-protected-resource`

Return `404` for `/device/*`. Do not open, forward, proxy, or create a public DNAT rule for port `39100`. Worker traffic belongs on the private network.

Run the public checks after HTTPS is active:

```bash
./scripts/remote-health-check.sh https://veronica.example.com
```

See [docs/deployment.md](docs/deployment.md) for a provider neutral reverse proxy, service, firewall, upgrade, and rollback guide.

### 5. Connect a worker

Copy the same device token to the worker through a protected secret channel. Never put it in Git, chat, shell history, or CI logs.

Set the private gateway URL and load the worker token from a protected secret source. The current prototype reads these values from the environment and does not provide built-in credential storage.

On Linux or macOS:

```bash
export VERONICA_GATEWAY="http://10.20.0.1:39100"
export VERONICA_TOKEN="<worker token>"
cd "$HOME/code"
veronica expose
```

On Windows PowerShell:

```powershell
$env:VERONICA_GATEWAY = "http://10.20.0.1:39100"
$env:VERONICA_TOKEN = "<worker token>"
Set-Location "C:\Users\you\code"
veronica expose
```

`veronica expose` exposes the current directory and uses the computer hostname as the device name. Supply a path or `--name` only when you want different values:

```bash
veronica expose /home/user/code --name laptop
```

Expose the smallest useful root. The worker must use the private gateway address, not the public hostname. Keep the command running, and stop the worker with `Ctrl+C`.

### 6. Connect an MCP client

Add this remote MCP server to a client that supports OAuth:

```text
https://veronica.example.com/mcp
```

Complete login and consent with the identity provider. Then call:

```text
list_devices
open_workspace(device="laptop", path="project")
read_file(workspace_id="...", path="README.md")
run_command(workspace_id="...", command="git status")
close_workspace(workspace_id="...")
```

If tool discovery returns `401`, inspect the access token issuer, audience, expiry, and permissions. If the worker does not appear, test private connectivity to the gateway and confirm both processes use the same device token.

### 7. Verify the security boundary

Before relying on the deployment, complete [docs/deployment-acceptance.md](docs/deployment-acceptance.md). At minimum verify:

- Public HTTPS serves MCP and protected resource metadata.
- Unauthenticated MCP requests return `401` with the required scopes and metadata URL.
- Public `/device/*` returns `404`.
- Public port `39100` is closed.
- The worker reaches port `39100` over the private network.
- An authenticated MCP client can list the worker and complete a disposable workspace test.

## How it works

The agent harness owns the model, conversation, planning, retries, and tool loop. Veronica only supplies the execution bridge. The gateway authenticates MCP requests, tracks devices in memory, and routes jobs. Workers poll the gateway and enforce workspace and path boundaries on the exposed computer.

There are no inbound connections to workers, persistent terminals, background processes, databases, or per-device certificates yet. Gateway restarts forget current devices and workspaces, and running workers register again automatically.

See [PHILOSOPHY.md](PHILOSOPHY.md) for the durable design rules and [docs/architecture.md](docs/architecture.md) for the component model.

## Development

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run check
```

Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before making structural changes. Maintainer specific deployment notes belong in a separate operator file, not in this quickstart. The current Ariobarin environment is documented in [docs/deployment-ariobarin.md](docs/deployment-ariobarin.md).

## License

MIT
