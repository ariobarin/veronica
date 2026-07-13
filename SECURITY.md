# Security

## Prototype warning

Veronica is experimental. Do not treat the current implementation as a hardened remote access product.

`veronica expose` runs commands with the permissions and environment of the user who launched it. A command can potentially access that user's credentials, network, developer tools, and any filesystem locations allowed by the operating system account. The exposed-root checks limit Veronica's file tools, but they do not sandbox shell commands.

## Current trust model

The prototype assumes:

- One trusted operator
- Trusted users authenticated by the configured OAuth identity provider
- Trusted computers running the worker
- TLS termination in front of any internet-facing gateway
- No hostile multi-tenant use

OAuth protects the public MCP endpoint. The gateway verifies access token signature, issuer, audience, expiry, and required scopes. A separate random bearer token protects private worker endpoints. Use at least 32 random characters for the device token and rotate it if exposed.

## Safe deployment guidance

- Bind the Node process only to loopback and the VPS WireGuard interface.
- Publish only `/mcp` and `/healthz` through a maintained HTTPS reverse proxy.
- Keep `/device/*` on WireGuard. Do not add public forwarding or DNAT for port `39100`.
- Do not use Cloudflare Tunnel for worker traffic.
- Expose the smallest useful directory.
- Run the worker under a dedicated operating system account when practical.
- Use a container or VM for untrusted repositories or unattended work.
- Workers read `VERONICA_TOKEN`. Gateways should use `VERONICA_DEVICE_TOKEN`; `VERONICA_TOKEN` remains an accepted gateway compatibility fallback in this revision.
- Do not expose a worker that has credentials the agent should not be able to use.

## Implemented controls

- `/mcp` requires an OAuth access token with the `veronica:access` scope.
- `/device/*` requires the private device bearer token.
- The gateway publishes OAuth protected resource metadata and returns a standards-based bearer challenge.
- A worker exposes one canonical directory root. With no path, the CLI selects the Git worktree root and refuses home or filesystem roots without explicit confirmation.
- File operations reject absolute paths and lexical parent escapes.
- Existing paths and writable ancestors are resolved to detect symlink escapes.
- Workspaces must be verified by the worker before use.
- Text file and captured command output are limited to 1 MiB.
- File reads return a SHA-256 revision, and writes may require that revision before atomic replacement.
- Queued jobs carry an expiry and are removed when their caller times out.
- Command duration is limited by the requested timeout, and worker shutdown also terminates the active process tree on Windows and Unix-like systems.
- Device, workspace, and job state is held only in memory.

## Known limitations

- One shared token is still used for all workers instead of per-device identities.
- OAuth authorization depends on the identity provider's user, client, consent, and revocation controls.
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
