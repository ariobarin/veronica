# Security

## Prototype warning

Veronica is experimental. Do not treat the current implementation as a hardened remote access product.

`veronica expose` runs commands with the permissions and environment of the user who launched it. A command can potentially access that user's credentials, network, developer tools, and any filesystem locations allowed by the operating system account. The exposed-root checks limit Veronica's file tools, but they do not sandbox shell commands.

## Current trust model

The prototype assumes:

- One trusted operator
- Trusted agent harnesses with the gateway token
- Trusted computers running the worker
- TLS termination in front of any internet-facing gateway
- No hostile multi-tenant use

The shared bearer token protects both MCP and worker endpoints. Use a random value of at least 32 characters and rotate it if exposed.

## Safe deployment guidance

- Bind the Node process only to loopback and the VPS WireGuard interface.
- Publish only `/mcp` and `/healthz` through a maintained HTTPS reverse proxy.
- Keep `/device/*` on WireGuard. Do not add public forwarding or DNAT for port `39100`.
- Do not use Cloudflare Tunnel for worker traffic.
- Expose the smallest useful directory.
- Run the worker under a dedicated operating system account when practical.
- Use a container or VM for untrusted repositories or unattended work.
- Do not pass the token on a command line in shared environments. Prefer `VERONICA_TOKEN`.
- Do not expose a worker that has credentials the agent should not be able to use.

## Implemented controls

- All non-health endpoints require a bearer token.
- A worker exposes one canonical directory root.
- File operations reject absolute paths and lexical parent escapes.
- Existing paths and writable ancestors are resolved to detect symlink escapes.
- Workspaces must be verified by the worker before use.
- Text file and captured command output are limited to 1 MiB.
- Command duration is limited by the requested timeout.
- Device, workspace, and job state is held only in memory.

## Known limitations

- One shared token is used instead of user and per-device identities.
- There is no OAuth, device enrollment, certificate rotation, or revocation list.
- There is no local approval prompt or durable audit log.
- Shell commands inherit the worker's environment.
- Shell execution is not isolated from the rest of the user account.
- A timed-out command receives a basic child-process kill, not a guaranteed process-tree kill on every platform.
- MCP disconnects do not yet cancel worker jobs.
- Command output is not streamed.
- The gateway has no persistence or multi-instance coordination.
- Denial-of-service protection and rate limiting are not implemented.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or contact the maintainer privately. Do not publish an exploit or sensitive deployment detail in a public issue before a fix is available.
