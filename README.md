# Veronica

Veronica exposes one local coding workspace to an existing agent harness through a small remote gateway.

```text
agent -> access-controlled MCP transport -> Veronica gateway -> private worker connection -> local workspace
```

The gateway provides six MCP tools: `list_devices`, `open_workspace`, `read_file`, `write_file`, `run_command`, and `close_workspace`. The worker makes outbound requests only, and filesystem enforcement happens on the computer that owns the files.

> Veronica is an early prototype, not a sandbox. Commands run with the permissions and environment of the worker account. Read [SECURITY.md](SECURITY.md) before exposing a workstation.

## Install

Node.js 20 or newer is required on the gateway and workers.

```bash
npm install --global @ariobarin/veronica
```

For a one-off invocation without a global install:

```bash
npx --yes @ariobarin/veronica --help
```

The package provides the `veronica` command and keeps `veronica-gateway` as a compatibility alias. On Windows, npm's global command directory is usually `%APPDATA%\npm`.

## Configure and start a gateway

Create a protected configuration file. The command generates a 256-bit worker token and prints it once so it can be transferred through a protected channel:

```bash
veronica init gateway \
  --hosts "127.0.0.1,10.20.0.1" \
  --port 39100 \
  --allowed-hosts "veronica.example.com,10.20.0.1,127.0.0.1,localhost"
veronica gateway
```

The configuration is stored in `~/.config/veronica/config.json` on Unix-like systems or `%APPDATA%\Veronica\config.json` on Windows. Set `VERONICA_CONFIG` to use another path. Environment variables override saved values; the namespaced gateway variables are `VERONICA_HOSTS`, `VERONICA_PORT`, `VERONICA_ALLOWED_HOSTS`, and `VERONICA_DEVICE_TOKEN`. Legacy `HOSTS` and `PORT` remain supported.

`veronica-gateway` remains available for existing service definitions and reads the same configuration.

The `/mcp` endpoint has no application-level authentication. Put it behind an access-controlled private tunnel, VPN, or reverse proxy that authenticates the intended MCP client. Never publish it as an anonymous internet endpoint. Expose only `/mcp` and optionally `/healthz` through that trusted transport. Keep `/device/*` and the gateway port on an operator-controlled private network.

The complete listener, proxy, service, upgrade, and rollback procedure is in [docs/deployment.md](docs/deployment.md).

## Configure and connect a worker

Save the gateway URL and worker token without placing the token in shell history:

```bash
printf '%s\n' '<worker token>' > /path/to/protected-token
veronica init worker \
  --gateway "http://10.20.0.1:39100" \
  --name laptop \
  --token-file /path/to/protected-token
rm /path/to/protected-token
```

Then enter a Git worktree and expose it:

```bash
cd "$HOME/code/project"
veronica
```

`VERONICA_GATEWAY` and `VERONICA_TOKEN` override saved worker settings. With no path, `veronica` selects the current Git worktree root. `veronica expose` is an equivalent explicit form. Outside a Git worktree, pass a directory. Home and filesystem roots require `--allow-broad-root`.

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

## Development from source

```bash
git clone https://github.com/ariobarin/veronica.git
cd veronica
npm ci --ignore-scripts
npm run check
npm link
```

Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before changing boundaries. Run `npm run test:coverage` before proposing runtime changes.

## Design and operations

- [PHILOSOPHY.md](PHILOSOPHY.md) defines the durable design boundaries.
- [docs/architecture.md](docs/architecture.md) describes devices, workspaces, jobs, and routing.
- [SECURITY.md](SECURITY.md) states the trust model and known limitations.
- [docs/deployment.md](docs/deployment.md) is the provider-neutral deployment guide.
- [docs/deployment-acceptance.md](docs/deployment-acceptance.md) is the production verification checklist.

## License

MIT
