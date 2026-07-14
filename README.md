# Veronica

Veronica exposes one local coding workspace to an existing agent harness through a small remote gateway.

```text
agent -> access-controlled MCP transport -> Veronica gateway -> private worker connection -> local workspace
```

The gateway provides six MCP tools: `list_devices`, `open_workspace`, `read_file`, `write_file`, `run_command`, and `close_workspace`. The worker makes outbound requests only, and filesystem enforcement happens on the computer that owns the files.

> Veronica is an early prototype, not a sandbox. Commands run with the permissions and environment of the worker account. Read [SECURITY.md](SECURITY.md) before exposing a workstation.

## Install

Node.js 20 or newer is required on the gateway and workers.

Install the published command-line tools:

```bash
npm install --global @ariobarin/veronica
```

For a one-off invocation without a global install:

```bash
npx --yes @ariobarin/veronica --help
```

The package provides the `veronica` command and keeps `veronica-gateway` as a compatibility alias.

To work from a repository checkout instead:

```bash
git clone https://github.com/ariobarin/veronica.git
cd veronica
npm ci --ignore-scripts
npm run check
npm link
```

On Windows, npm's global command directory is usually `%APPDATA%\npm`.

## Start a gateway

Generate one shared worker token, choose the loopback and private-network listener addresses, and start the gateway:

```bash
export VERONICA_DEVICE_TOKEN="$(openssl rand -hex 32)"
export HOSTS="127.0.0.1,10.20.0.1"
export PORT="39100"
export VERONICA_ALLOWED_HOSTS="veronica.example.com,10.20.0.1,127.0.0.1,localhost"
veronica gateway
```

`veronica-gateway` remains available for existing service definitions.

The `/mcp` endpoint has no application-level authentication. Put it behind an access-controlled private tunnel, VPN, or reverse proxy that authenticates the intended MCP client. Never publish it as an anonymous internet endpoint.

Expose only `/mcp` and optionally `/healthz` through that trusted transport. Keep `/device/*` and the gateway port on an operator-controlled private network.

The complete listener, proxy, service, upgrade, and rollback procedure is in [docs/deployment.md](docs/deployment.md).

## Connect a worker

Load the worker token from a protected source, enter a Git worktree, and start the worker:

```bash
export VERONICA_GATEWAY="http://10.20.0.1:39100"
export VERONICA_TOKEN="<worker token>"
cd "$HOME/code/project"
veronica --name laptop
```

With no path, `veronica` selects the current Git worktree root. `veronica expose` is an equivalent explicit form. Outside a Git worktree, pass a directory. Home and filesystem roots require `--allow-broad-root`.

The worker prints the canonical exposed root before connecting. Stop it with `Ctrl+C`.

## Use the MCP tools

Connect an MCP client through the trusted transport to:

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
