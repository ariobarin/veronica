# Security

## Prototype warning

Veronica is experimental. Do not treat the current implementation as a hardened remote access product.

`veronica expose` runs commands with the permissions and environment of the user who launched it. A command can potentially access that user's credentials, network, developer tools, and any filesystem locations allowed by the operating system account. The exposed-root checks limit Veronica's file tools, but they do not sandbox shell commands.

## Current trust model

The prototype assumes:

- One trusted operator
- Trusted users admitted by the transport or reverse proxy in front of `/mcp`
- Trusted computers running the worker
- TLS termination in front of any internet-reachable MCP transport
- No hostile multi-tenant use

Veronica does not authenticate MCP clients. The system that exposes `/mcp` must provide the access boundary, such as an authenticated private tunnel, VPN, mutually authenticated proxy, or equivalent operator-controlled transport. A separate random bearer token protects private worker endpoints. Use at least 32 random characters for the device token and rotate it if exposed.

## Safe deployment guidance

- Bind the Node process only to loopback and the gateway's private network interface.
- Expose `/mcp` only through a transport that admits the intended MCP clients.
- Never publish `/mcp` as an anonymous internet endpoint.
- Publish `/healthz` only when operationally useful.
- Keep `/device/*` on the private network. Do not add public forwarding or DNAT for the gateway port.
- Do not use a public tunnel for worker traffic.
- Expose the smallest useful directory.
- Run the worker under a dedicated operating system account when practical.
- Use a container or VM for untrusted repositories or unattended work.
- Workers read `VERONICA_TOKEN`; gateways accept only `VERONICA_DEVICE_TOKEN` on `/device/*`.
- Do not expose a worker that has credentials the agent should not be able to use.

## Implemented controls

- `/mcp` is intentionally unauthenticated inside the gateway and relies on the surrounding transport boundary.
- `/device/*` requires the private device bearer token.
- A worker exposes one canonical directory root. With no path, the CLI selects the Git worktree root and refuses home or filesystem roots without explicit confirmation.
- File operations reject absolute paths and lexical parent escapes.
- Existing paths and writable ancestors are resolved to detect symlink escapes.
- Workspaces must be verified by the worker before use.
- Text file and captured command output are limited to 1 MiB.
- File reads return a SHA-256 revision, and writes may require that revision before atomic replacement.
- Queued jobs carry an expiry and are removed when their caller times out.
- Command duration is limited by the requested timeout, and worker shutdown also terminates the active process tree on Windows and Unix-like systems.
- Device, workspace, and job state is held only in memory.
- MCP tool annotations describe write and command operations as non-read-only and destructive-capable.

## Known limitations

- The gateway cannot identify, authorize, or revoke individual MCP clients; those controls belong to the surrounding transport.
- One shared token is used for all workers instead of per-device identities.
- There is no device enrollment, certificate rotation, or device revocation list.
- There is no local approval prompt or durable audit log.
- Shell commands inherit the worker's environment.
- Shell execution is not isolated from the rest of the user account.
- Timed-out commands use operating system process-tree termination, but abrupt termination can still leave application-level state partially written.
- Unix termination discovers current descendants by parent PID as well as process group. A process that fully daemonizes and reparents before discovery can still escape; use a container or virtual machine when that boundary matters.
- Gateway expiry prevents queued work from starting late, but it does not cancel a command that already started.
- MCP disconnects do not yet cancel worker jobs.
- Revision checks detect stale content observed before replacement but are not a cross-process file-locking system.
- Command output is not streamed.
- The gateway has no persistence or multi-instance coordination.
- Denial-of-service protection and rate limiting are not implemented.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or contact the maintainer privately. Do not publish an exploit or sensitive deployment detail in a public issue before a fix is available.
