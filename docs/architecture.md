# Architecture

## Components

```text
agent harness
    |
    | OAuth-authenticated MCP over HTTPS
    v
Veronica gateway
    |
    | authenticated HTTP polling over WireGuard
    v
veronica expose <directory>
    |
    v
local files and shell
```

### Agent harness

The harness owns the model, conversation, reasoning, tool scheduling, retries, and user interaction. Veronica only appears as an MCP tool provider.

### Gateway

The gateway is one Node.js process. It holds connected devices, pending jobs, and workspace leases in memory. It exposes the MCP endpoint and three worker endpoints:

```text
POST /device/register
POST /device/poll
POST /device/result
POST /mcp
GET  /healthz
```

A restart forgets all devices, jobs, and workspaces. Workers reconnect automatically.

Public MCP clients and private workers have separate authentication boundaries. MCP clients use OAuth access tokens issued for the Veronica resource with `veronica:read` and `veronica:write` scopes. Workers use a random device bearer token only across the operator-controlled WireGuard network. The shared device token is never accepted on `/mcp`.

### Worker

`veronica expose` canonicalizes one local root, registers a device name, and repeatedly long-polls for one job. It validates paths and executes jobs locally. The worker makes only outbound HTTP requests.

## Resource model

### Device

A device is one running worker process with a unique name and a non-sensitive exposed-root label. The prototype assumes one connected device per name. Offline records are removed after a bounded retention window.

### Workspace

A workspace is a gateway lease containing:

```text
workspace id
selected device id
path relative to the exposed root
```

Opening a workspace asks the worker to verify that the directory exists. When the caller omits a device, the gateway selects it only if exactly one worker is online. Every later operation revalidates the workspace path on the worker.

### Job

A job is one request routed to one device. The gateway removes work that is still queued when its caller times out. Work already delivered to a worker may continue because cancellation is not yet implemented; any result returned after the caller timeout is ignored.

## Current protocol

Worker requests are a small tagged union:

```text
open_workspace
read_file
write_file
run_command
```

File reads return a SHA-256 revision. File writes replace content atomically and may require an expected revision to detect stale edits. Command jobs accept exactly one direct argument array or shell command and may carry standard input. Direct execution avoids host-shell quoting, while explicit shell commands use `cmd.exe` on Windows and `/bin/sh` elsewhere. The MCP gateway adds discovery and lease management around those operations:

```text
list_devices
open_workspace
read_file
write_file
run_command
close_workspace
```

## Why long polling first

Long polling works through NAT and ordinary reverse proxies, requires no inbound connection to the worker, and avoids another transport dependency. It is not intended to support terminal byte streams. A later transport may use WebSocket, SSH, or another bidirectional protocol while keeping the same device, workspace, and job resources.

## Failure behavior

- If the gateway restarts, workers receive an unknown-device response and register again.
- If a worker disappears, queued MCP calls eventually time out.
- If an MCP client disconnects, the current prototype does not cancel a worker job.
- A queued job is removed when its caller times out. A command that already started is not yet cancelled by a gateway timeout.
- If a device reconnects under a stale name, old workspaces for that device are removed.
- Command output is capped at 1 MiB and returned only when the process exits.
- Command timeouts terminate the operating system process group plus discovered descendants and report `timedOut` in the completed result. Stopping the worker applies the same termination path before the worker exits.

## Growth order

Add capabilities only when a concrete workflow requires them. The expected order is:

1. Better device identity and authentication
2. Job cancellation and output streaming
3. Background job resources
4. Local approval and audit surfaces
5. Optional sandbox execution profiles
6. Persistent terminal resources

The order is guidance, not a roadmap commitment.
