# Veronica philosophy

This file records the constraints that should remain true as Veronica grows. Features are optional. These boundaries are not.

## One sentence

Veronica turns an explicitly exposed local directory into a named remote coding workspace for an existing agent harness.

## Design rules

### The outer harness owns the intelligence

Veronica does not choose models, maintain conversations, plan work, compact context, or run an agent loop. It provides execution tools to a harness that already does those things.

### The gateway routes but does not compute

The gateway should remain suitable for a small relay VPS. It authenticates, discovers devices, creates short workspace leases, routes requests, and returns results. Repositories, builds, terminals, and credentials stay on the exposed computers.

### Exposure is explicit and temporary by default

A computer becomes available because a user runs `veronica expose <path>`. Stopping that process removes the useful connection. Persistent service mode may come later, but it must remain an explicit choice.

### A directory is exposed, not a computer

The default unit of access is one filesystem root. Requests use relative paths. Absolute paths and escapes are rejected on the worker, even if the gateway accepted or produced a bad request.

### Local enforcement is authoritative

The gateway is not trusted to widen access. Path containment, process policy, limits, and future approvals must be enforced by the worker on the computer that owns the resources.

### Direct shell access is described honestly

A shell running as a normal user can generally access that user's files, environment, credentials, network, and developer tools. Command filtering is not a sandbox. Strong isolation must come from a separate operating system account, container, VM, or similar boundary.

### Start with completed operations

The initial protocol supports completed file operations and one-shot commands. Persistent terminals, background jobs, streaming logs, and process reattachment should be added only after the basic request and cancellation semantics are clear.

### Prefer resources over hidden sessions

Devices and workspaces are explicit resources with identifiers. Future jobs and terminals should follow the same pattern. A reconnecting MCP client must not depend on an invisible shell prompt or one particular HTTP connection.

### Keep the protocol boring

Use small JSON messages over standard HTTP where possible. Avoid infrastructure that the problem does not yet require. A feature should justify every new daemon, database, queue, and dependency.

### Preserve agent portability

The MCP surface should make sense to ChatGPT, Codex, Pi, and other agent harnesses. Harness-specific behavior belongs in adapters, not in the worker protocol.

### Documentation is part of the implementation

A change that alters trust, ownership, persistence, routing, or execution is incomplete until the corresponding design and security documents are updated.

## Decision filter

Before adding a feature, ask:

1. Is this execution infrastructure, or is it agent behavior that belongs in the harness?
2. Can the gateway remain a small router after this change?
3. Can the worker enforce the boundary without trusting the gateway?
4. Does the feature need persistent state, or can it be represented by a short resource lease?
5. Is there a smaller protocol that proves the need first?
6. Does the documentation state the new risk and failure mode plainly?

## Current deliberate limitations

The prototype uses one shared bearer token, in-memory routing, long polling, one exposed root per worker, completed command output, and no sandbox. These are not claims about the final architecture. They are the smallest choices that test whether the core interaction is useful.
