# Veronica

Veronica exposes one local coding workspace to an existing agent harness through a small remote gateway.

```text
agent -> OAuth-protected MCP gateway -> private worker connection -> local workspace
```

The gateway provides six MCP tools: `list_devices`, `open_workspace`, `read_file`, `write_file`, `run_command`, and `close_workspace`. The worker makes outbound requests only, and filesystem enforcement happens on the computer that owns the files.

> Veronica is an early prototype, not a sandbox. Commands run with the permissions and environment of the worker account. Read [SECURITY.md](SECURITY.md) before exposing a workstation.

## Install

Node.js 20 or newer is required on the gateway and workers.

```bash
git clone https://github.com/ariobarin/veronica.git
cd veronica
npm ci --ignore-scripts
npm run check
npm link
```

`npm link` installs the built `veronica` and `veronica-gateway` commands. On Windows, npm's global command directory is usually `%APPDATA%\npm`.

## Start a gateway

Configure an OAuth protected resource whose identifier and JWT audience are the public Veronica resource URL. It must issue RS256 access tokens with the `veronica:access` scope.

Existing deployments using only `veronica:read` and `veronica:write` must grant `veronica:access` before upgrading and obtain fresh access tokens afterward.

```bash
export VERONICA_DEVICE_TOKEN="$(openssl rand -hex 32)"
export VERONICA_OAUTH_ISSUER="https://identity.example.com/"
export VERONICA_OAUTH_RESOURCE="https://veronica.example.com/"
export HOSTS="127.0.0.1,10.20.0.1"
export PORT="39100"
export VERONICA_ALLOWED_HOSTS="veronica.example.com,10.20.0.1,127.0.0.1,localhost"
npm start
```

Publish only `/mcp`, `/healthz`, and `/.well-known/oauth-protected-resource` through HTTPS. Keep `/device/*` and the gateway port on an operator-controlled private network.

The complete listener, reverse-proxy, service, upgrade, and rollback procedure is in [docs/deployment.md](docs/deployment.md).

## Connect a worker

Load the worker token from a protected source, enter a Git worktree, and start the worker:

```bash
export VERONICA_GATEWAY="http://10.20.0.1:39100"
export VERONICA_TOKEN="<worker token>"
cd "$HOME/code/project"
veronica expose --name laptop
```

With no path, `veronica expose` selects the current Git worktree root. Outside a Git worktree, pass an explicit directory. Home and filesystem roots require `--allow-broad-root`.

The worker prints the canonical exposed root before connecting. Stop it with `Ctrl+C`.

## Use the MCP tools

Connect an OAuth-capable MCP client to:

```text
https://veronica.example.com/mcp
```

When exactly one worker is online, open it directly:

```text
open_workspace(path=".")
read_file(workspace_id="...", path="README.md")
run_command(workspace_id="...", argv=["git", "status"])
close_workspace(workspace_id="...")
```

Call `list_devices` only when device selection is ambiguous. Device results include a non-sensitive root label.

`read_file` returns the UTF-8 content and a SHA-256 revision. `write_file` atomically replaces content and can require `expected_sha256` to reject a stale edit.

`run_command` accepts exactly one of:

- `argv`, for direct execution without host-shell quoting
- `shell_command`, for explicit `cmd.exe` on Windows or `/bin/sh` elsewhere

The deprecated `command` field remains an alias for `shell_command` so connectors that cached the original MCP schema continue to work. New integrations should use `argv` or `shell_command`.

It also accepts optional standard input and reports spawn errors, output truncation, and timeouts in structured fields.

## Design and operations

- [PHILOSOPHY.md](PHILOSOPHY.md) defines the durable design boundaries.
- [docs/architecture.md](docs/architecture.md) describes devices, workspaces, jobs, and routing.
- [SECURITY.md](SECURITY.md) states the trust model and known limitations.
- [docs/deployment.md](docs/deployment.md) is the provider-neutral deployment guide.
- [docs/deployment-acceptance.md](docs/deployment-acceptance.md) is the production verification checklist.

## Development

Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before changing boundaries.

```bash
npm ci --ignore-scripts
npm run check
npm run test:coverage
```

## License

MIT
