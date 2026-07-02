# Holt

**Everything you know, kept and connected.**

Holt is an open-source, self-hosted personal agent OS. Clone it, pick your skills, choose your brain, and it runs on *your* machine with persistent memory you can actually see and walk.

> A *holt* is a small wood: a sheltered place where things are kept and grow. That's the idea. A private home for your knowledge that compounds over time.

> **Status: early but usable.** `holt init` and `holt chat` work today. A "brain" is an agent CLI (Claude Code, Codex, or Gemini). Holt can install a missing one for you and hand off to its sign-in, and you can switch brains mid-conversation without losing context. Memory, skills, and the knowledge graph are the next phases.

---

## Quickstart

```bash
npm install -g @holt-os/holt
cd ~/where-you-want-to-work
holt init      # trust this folder, choose and install brains, sign in, set defaults
holt chat      # start talking (or use your custom command, e.g. `ai`)
```

## First run

Holt runs in the folder you launch it from, like a per-project tool. The first time you use a folder it asks:

```
Trust this folder?
  /Users/you/where-you-want-to-work
  Holt will read and write here.
  Trust and continue? [y/N]
```

Trusted folders are remembered in `~/.holt/trust.json`. Everything Holt writes for that folder (its config, and later its memory) stays in `<folder>/.holt/`.

During `holt init` you:

1. **Trust the folder.**
2. **Choose brains** (claude, codex, gemini). Holt installs any you pick that are missing.
3. **Sign in.** For a newly installed brain, Holt starts that tool's own login (browser or its own prompt). Holt never stores your credentials.
4. **Pick a default** brain and, optionally, a **launch command** (a short word like `ai` that runs `holt chat`).

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

A brain is an agent CLI installed and logged in on your machine. No API keys to paste.

| Brain | Command | Install |
|-------|---------|---------|
| Claude Code | `claude` | `npm i -g @anthropic-ai/claude-code` |
| Codex | `codex` | `npm i -g @openai/codex` |
| Gemini CLI | `gemini` | `npm i -g @google/gemini-cli` |

`holt init` runs these for you when you pick a brain that is missing. You can also sign in any time with `holt login <brain>`. Raw API providers are planned for a later phase.

## Commands

```
holt init            set up (trust, brains, sign-in, defaults) for this folder
holt chat            start a session
holt setting         configure brains and launch command
holt login <brain>   sign in to claude, codex, or gemini
holt version         print version
holt help            show help
```

## Configuration

`holt init` writes `<folder>/.holt/config.json` (default brain and enabled brains for that folder). Trusted folders live in `~/.holt/trust.json`. Edit settings with `holt setting`.

## Architecture

Small strongly-typed **TypeScript core** (command dispatch, brain router, transcript, and a plugin dispatcher coming with skills). Brains and, soon, skills and channels are adapters. See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Roadmap

Built in always-shippable phases toward a full-vision v1:

0. **Skeleton and chat**: trust, init with install and sign-in, chat, brain switching with kept context *(shipped)*
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
