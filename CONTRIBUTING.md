# Contributing to Holt

Thanks for your interest! Holt is designed so you can extend it **without touching the core**.

> Holt is in early development (Phase 0). The core is still taking shape, so the smoothest way to help right now is with ideas, issues, and plugin/skill design feedback.

## Ways to contribute

- **Skills**: Holt uses the [agentskills.io](https://agentskills.io) format. A skill is largely Markdown; you don't need to read the core to write one.
- **Plugins**: providers, channels, embeddings, and tools are [MCP](https://modelcontextprotocol.io) servers. Write them in any language that speaks MCP.
- **Core**: TypeScript. Small and strongly typed. See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Getting started (dev)

```bash
git clone https://github.com/holt-os/holt.git
cd holt
npm install
npm run dev            # runs the CLI from source
npm run typecheck
```

## Ground rules

- Keep the core small. If it can be a plugin, make it a plugin.
- Never commit secrets or personal data. `config.yml`, `.env`, and `*.db` are git-ignored for a reason.
- Open an issue to discuss larger changes before a big PR.

## License

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
