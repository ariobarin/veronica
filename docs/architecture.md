# Architecture

## Components

```text
agent harness
    |
    | MCP over an access-controlled HTTPS transport
    v
Veronica gateway
    |
    | device-token HTTP polling over a private network
    v
veronica expose <directory>
    |
    v
local files and shell
```

### Agent harness

The harness owns the model, conversation, reasoning, tool scheduling, retries, and user interaction. Veronica only appears as an MCP tool provider.

### Trusted transport

Veronica does not authenticate MCP clients. An authenticated private tunnel, VPN, mutually authenticated proxy, or equivalent operator-controlled transport must decide which clients can reach a production `/mcp` endpoint. The gateway treats every request that reaches that endpoint as trusted.

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

MCP clients and private workers have separate boundaries. Client admission happens before traffic reaches the gateway. Workers use a random device bearer token only across the operator-controlled private network. The shared device token is accepted only on `/device/*` and is not an MCP client credential.

### Worker

`veronica expose` canonicalizes one local root, registers a device name, and repeatedly long-polls for one job. It validates paths and executes jobs locally. The worker makes only outbound HTTP requests.

### Local mode

`veronica local` combines the gateway and worker lifecycle for development and evaluation:

```text
local MCP client -> http://127.0.0.1:<ephemeral>/mcp
                        |
                        v
              ephemeral Veronica gateway
                        |
                        | random in-memory device token over loopback
                        v
              selected local Git worktree
```

The command creates a random worker token, starts the gateway on an operating-system-assigned IPv4 loopback port, starts a worker against the selected root, and closes both when interrupted. It does not read or write the saved gateway and worker credentials.

Local mode preserves the normal workspace, path, file-revision, command, timeout, and process-tree enforcement. It changes only the routing and lifecycle. Its `/mcp` endpoint is still unauthenticated, so loopback reachability is the only client boundary; any local process that can connect to the port is trusted. It is not a remote deployment mode and must not be forwarded or tunneled.

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

The write and command tools are reported as non-read-only and destructive-capable. Tool metadata is descriptive, not a security boundary, but it must remain accurate so an agent harness can apply its own confirmation policy.

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
- If local mode cannot bind loopback, it closes the partial listener and exits without starting a worker.
- Stopping local mode aborts the worker before closing its ephemeral gateway.

## Growth order

Add capabilities only when a concrete workflow requires them. The expected order is:

1. Better device identity and authentication
2. Job cancellation and output streaming
3. Background job resources
4. Local approval and audit surfaces
5. Optional sandbox execution profiles
6. Persistent terminal resources

The order is guidance, not a roadmap commitment.
