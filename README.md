# Holt

**Everything you know, kept and connected.**

Holt is an open-source, self-hosted personal agent OS. Clone it, pick your skills, choose your brain, and it runs on *your* machine with persistent memory you can actually see and walk.

> A *holt* is a small wood: a sheltered place where things are kept and grow. That's the idea. A private home for your knowledge that compounds over time.

> **Status: early but usable.** `holt init` and `holt chat` work today. Right now a "brain" is an agent CLI you already have (Claude Code, Codex, or Gemini), and you can switch between them mid-conversation without losing context. Memory, skills, and the knowledge graph are the next phases.

---

## Quickstart

```bash
npm install -g @holt-os/holt
holt init      # finds your agent CLIs, pick a brain, set a launch command
holt chat      # start talking (or use your custom command, e.g. `ai`)
```

`holt init` looks for the agent CLIs on your machine (`claude`, `codex`, `gemini`), lets you pick a default, and optionally sets a short launch word so you can start Holt by typing something like `ai` instead of `holt chat`.

## Using it

Inside `holt chat`:

```
/brain            list your brains and see which is active
/brain gemini     switch brain. your conversation context is kept
/setting          configure brains and your launch command
/clear            forget the conversation so far
/help             show commands
/exit             leave
```

The point of `/brain`: Holt owns the transcript, so you can start a thread on one model and hand it to another mid-conversation. The new brain picks up with the full context.

## Brains

In this phase a brain is an agent CLI already installed and logged in on your machine. No API keys to paste.

| Brain | Command | Get it |
|-------|---------|--------|
| Claude Code | `claude` | Anthropic |
| Codex | `codex` | OpenAI |
| Gemini CLI | `gemini` | Google |

Install at least one, then run `holt init`. Raw API providers are planned for a later phase.

## Configuration

`holt init` writes `~/.holt/config.json` (your default brain, detected brains, and launch command). Edit it with `holt setting` or by hand.

## Architecture

Small strongly-typed **TypeScript core** (command dispatch, brain router, transcript, and a plugin dispatcher coming with skills). Brains and, soon, skills and channels are adapters. See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Roadmap

Built in always-shippable phases toward a full-vision v1:

0. **Skeleton and chat**: init, chat, brain switching with kept context *(shipped)*
1. **Memory**: sqlite-vec store, local or cloud embeddings, recall across sessions
2. **Any LLM directly**: raw provider brains and an HTML or Markdown output toggle
3. **Skills**: install, search, and publish in the agentskills.io format
4. **Knowledge graph**: a view where you can see and navigate your own memory
5. **Orchestration**: a local model works, a cloud model reviews the risky steps
6. **Channels and polish**: Telegram, docs, one-command setup

## Contributing

Holt is built to be extended without touching the core. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Debashis Nayak
