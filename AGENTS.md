# Maintainer guidance

## Purpose

Veronica is a thin execution bridge between an agent harness and explicitly exposed local coding workspaces. Keep it small enough to run through a low-resource relay VPS.

Read `PHILOSOPHY.md`, `docs/architecture.md`, and `SECURITY.md` before changing boundaries or adding infrastructure.

## Rules

- Do not add an LLM, agent loop, conversation store, planner, or model provider integration.
- Keep the gateway free of repository clones, build execution, and user development credentials.
- Enforce filesystem and process boundaries on the worker, not only on the gateway.
- Expose narrow roots. Never make whole-machine access the default.
- Treat arbitrary shell access as full access under the worker's operating system user.
- Keep devices and workspaces explicit. Do not hide state in one transport connection.
- Prefer one-shot commands before persistent terminals and background process machinery.
- Keep direct dependencies exact. Add generated dependency state only when the repository deliberately adopts it.
- Do not commit tokens, keys, logs, local paths, sessions, or generated runtime state.
- Use one scope per branch or pull request. Preserve unrelated work.
- Use short lowercase commit subjects with no trailing punctuation.
- Update documentation in the same change when behavior, trust, or ownership changes.

## Workflow

1. State the smallest useful behavior being added.
2. Identify which component owns it: harness, gateway, worker, or deployment.
3. Add or update tests for local enforcement and routing semantics.
4. Run `npm run check`.
5. Verify the real CLI or HTTP flow when the change affects integration.
6. Open a focused pull request with a short explanation of why the change is needed.

## Near-term non-goals

- General remote desktop or whole-machine administration
- A second coding agent running on each worker
- Multi-tenant hosting
- Kubernetes or a distributed job queue
- Persistent interactive terminals before job semantics exist
- A command allowlist presented as a security sandbox
