# Veronica

Veronica lets an agent use a directory on one of your computers as a remote coding workspace.

```text
agent -> MCP gateway -> exposed computer -> files and shell
```

On a computer you want to expose:

```bash
veronica expose ~/code --name desktop
```

The agent can then discover `desktop`, open a workspace below `~/code`, read and write files, and run shell commands there.

> Veronica is an early prototype. It runs commands with the permissions and environment of the user who starts it. Read [SECURITY.md](SECURITY.md) before connecting it to the public internet.

## Why Veronica exists

An agent harness already owns the model, conversation, planning, retries, and tool loop. Veronica should not duplicate that machinery. It supplies only the missing execution bridge to computers the user explicitly exposes.

The gateway is intentionally small. It authenticates requests, tracks connected devices in memory, and routes jobs. The exposed computer performs all filesystem and process work.

See [PHILOSOPHY.md](PHILOSOPHY.md) for the durable design rules and [docs/architecture.md](docs/architecture.md) for the current shape.

## Current prototype

The first version has one CLI command:

```bash
veronica expose [path] --name <device>
```

It exposes six MCP tools:

- `list_devices`
- `open_workspace`
- `read_file`
- `write_file`
- `run_command`
- `close_workspace`

The worker polls the gateway over ordinary HTTPS. There are no inbound connections to the exposed computer, persistent terminals, background processes, databases, or device certificates yet.

## Run locally

Requirements:

- Node.js 20 or newer
- A random shared token of at least 32 characters

Install and build:

```bash
npm install --ignore-scripts
npm run build
```

Start the gateway:

```bash
export VERONICA_TOKEN="$(openssl rand -hex 32)"
npm run dev:gateway
```

In another terminal, expose a directory:

```bash
export VERONICA_TOKEN="the-same-token"
npm run dev -- expose ~/code --name desktop
```

The MCP endpoint is:

```text
http://127.0.0.1:3000/mcp
```

Send the same token as an HTTP bearer token. In a deployed setup, put the gateway behind HTTPS and keep the Node process bound to a private or loopback interface.

## Example agent flow

```text
list_devices
open_workspace(device="desktop", path="relay")
read_file(workspace_id="...", path="README.md")
run_command(workspace_id="...", command="git status")
close_workspace(workspace_id="...")
```

A workspace is pinned to one device. All paths are relative to that workspace and are checked again on the exposed computer.

## Development

```bash
npm run build
npm test
npm run check
```

Changes should stay small and update the design documents when they change a boundary or assumption. Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before making structural changes.

## License

MIT
