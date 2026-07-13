# Contributing

Veronica is intentionally small. Start by reading `PHILOSOPHY.md`, `AGENTS.md`, and `SECURITY.md`.

Before opening a pull request:

```bash
npm install --ignore-scripts
npm run check
```

Keep pull requests focused. Explain the concrete workflow that needs the change and why it belongs in Veronica rather than the outer agent harness. Update the design and security documents when a change affects trust, persistence, routing, or execution.

Security reports should follow `SECURITY.md`, not the public issue tracker.
