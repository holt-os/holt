# Holt

**Everything you know, kept and connected.**

Holt is an open-source, self-hosted personal agent OS. Clone it, pick your skills, choose your brain — and it runs on *your* machine with persistent memory you can actually see and walk.

> A *holt* is a small wood — a sheltered place where things are kept and grow. That's the idea: a private home for your knowledge that compounds over time.

> 🚧 **Status: early development (Phase 0).** The architecture and roadmap are locked and the CLI skeleton is here, but Holt is not yet functional end-to-end. Star/watch to follow along — contributions welcome.

---

## Why Holt

- 🧠 **Memory you can see.** Persistent RAG memory plus a *navigable knowledge graph* of everything you feed it — not a black-box profile you have to trust.
- 🔌 **Any LLM.** Claude, OpenAI, Gemini, or a local model — swap your brain with one line of config. No vendor lock-in.
- 💸 **Local executes, cloud reviews.** Run a local model for the work and let a premium cloud model review only the risky, irreversible steps. Cheap and private by design.
- 🧩 **MCP plugin pantry.** Skills, channels, providers, embeddings — everything is a plugin speaking the [Model Context Protocol](https://modelcontextprotocol.io). Extend it in any language.
- 📚 **Standard skills.** Compatible with the [agentskills.io](https://agentskills.io) skill format — pull from the community catalog or publish your own.
- 🖥️ **CLI-first.** Works in your terminal the moment you clone. Telegram and other channels are opt-in.

## Quickstart

> Not functional yet — this is the intended interface (Phase 0).

```bash
npm install -g holt      # or: pnpm add -g holt
holt init                # pick your brain + memory (local or cloud)
holt chat                # start talking
```

Add skills:

```bash
holt skill search finance
holt skill add deep-research
```

## Configuration

Copy `config.example.yml` to `config.yml` and edit. See the file for the full schema — brain/provider, memory + embeddings, output format (HTML or Markdown), orchestration, and channels.

## Architecture

Small strongly-typed **TypeScript core** (agent loop, brain router, memory orchestration, risky-action review gate, plugin dispatcher). *Everything else* is an MCP plugin — providers, embeddings, skills, channels. See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Roadmap

Built in always-shippable phases toward a full-vision v1:

0. **Skeleton** — core loop + CLI *(in progress)*
1. **Memory** — sqlite-vec RAG + embeddings
2. **Any-LLM** — provider plugins + output toggle
3. **Skills** — agentskills.io catalog + installer
4. **Knowledge graph** — navigable memory view
5. **Orchestration** — local-executes / cloud-reviews
6. **Channels + polish** — Telegram, docs, one-command install

## Contributing

Holt is built to be extended without touching the core. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Debashis Nayak
