# Holt

**Everything you know, kept and connected.**

Holt is an open-source, self-hosted personal agent OS. Clone it, pick your skills, choose your brain, and it runs on *your* machine with persistent memory you can actually see and walk.

> A *holt* is a small wood: a sheltered place where things are kept and grow. That's the idea. A private home for your knowledge that compounds over time.

> **Status: young but genuinely useful.** Working today: `holt init` and `holt chat`, brains as agent CLIs (Claude Code, Codex, Gemini) or direct API connections with your own key, mid-conversation brain switching that keeps context, persistent per-folder memory with semantic recall, skills in the portable SKILL.md format, and `holt graph`: your memory drawn as an interactive knowledge graph.

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
4. **Pick a default** brain and, optionally, a **launch command**: a short word like `ai` that starts `holt chat`. Holt installs it as a tiny launcher next to its own binary, so it works immediately in the same terminal, no sourcing or restart needed.
5. **Enable semantic memory.** If you say yes, Holt sets up a local [Ollama](https://ollama.com) with a small embed model so recall works by meaning, fully offline.

## Using it

Inside `holt chat`:

```
/brain            list your brains and see which is active
/brain gemini     switch brain. your conversation context is kept
/skill <name>     run a skill on your input
/memory           memory stats. /memory <query> previews what recall would surface
/output           show or set the save format: markdown | html
/save [name]      save the last reply to a file in this folder
/setting          configure brains, API brains, and your launch command
/clear            forget this session (saved memory stays)
/help             show commands
/exit             leave
```

The point of `/brain`: Holt owns the transcript, so you can start a thread on one model and hand it to another mid-conversation. The new brain picks up with the full context.

## Memory

Every exchange is saved to `<folder>/.holt/memory/turns.jsonl`, private and local. On each message, Holt recalls the most relevant moments from your *past* sessions in that folder and hands them to the brain, so it remembers what you told it last week.

Two recall modes, picked automatically:

- **Semantic** (best): a local [Ollama](https://ollama.com) with an embedding model, which `holt init` offers to set up for you. Recall matches by meaning: asking "who owns my apartment" finds "my landlord is called Pieter". No API keys, nothing leaves your machine.
- **Keyword** (fallback): with no Ollama, recall matches by word overlap. Still useful, zero setup.

Inspect it any time:

```bash
holt memory                    # stats for this folder
holt memory search <query>     # find remembered moments
holt memory embed              # embed older moments for semantic recall
holt memory clear              # wipe this folder's memory
```

Turns saved before semantic memory was enabled are upgraded in one pass with `holt memory embed`.

Long conversations stay cheap: only recent turns are replayed verbatim, older context comes back through recall.

## Brains

A brain is an agent CLI installed and logged in on your machine. No API keys to paste.

| Brain | Command | Install |
|-------|---------|---------|
| Claude Code | `claude` | `npm i -g @anthropic-ai/claude-code` |
| Codex | `codex` | `npm i -g @openai/codex` |
| Gemini CLI | `gemini` | `npm i -g @google/gemini-cli` |

`holt init` runs these for you when you pick a brain that is missing. You can also sign in any time with `holt login <brain>`.

### Direct API brains

A brain can also be a direct provider connection: no CLI install, your own key. Run `holt setting` and pick `[c] connect API brain`, or say yes to the API-brain question in `holt init`. Choose a provider (anthropic, openai, gemini), a model (suggestions offered, type anything), and a short name. For the key, paste a raw key (stored in `~/.holt/credentials.json`, mode 600) or give the name of an env var that holds it. Resolution order: the brain's `keyEnv`, the credentials file, then the standard env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). API brains stream and share memory exactly like CLI brains; switch with `/brain <name>`.

## See your memory: `holt graph`

`holt graph` turns this folder's memory into a picture you can walk. It writes one self-contained HTML file to `./.holt/graph.html` and opens it in your browser. No server, no CDN, no tracking: one file you can keep or share.

- Every turn is a node: yours glow amber, the assistant's cyan, and turns from the same session share a colored ring.
- Recurring ideas surface as concept nodes that tie related turns together.
- Turns that mean similar things (when local embeddings exist) get a strong link.
- Drag to pan, scroll to zoom, click a turn to read it in full, click a concept to light up its turns, and search to highlight matching memory live.

Options: `--out <path>` to write elsewhere, `--no-open` to skip the browser.

## Skills

A skill is a folder with a `SKILL.md`: YAML frontmatter (`name`, `description`) plus Markdown instructions. Same convention as agentskills.io and Claude Code, so skills are portable both ways. Skills are prompt text only; Holt never executes their contents.

Holt looks in two places (workspace wins on a name clash): `./.holt/skills/` for this folder, `~/.holt/skills/` for every folder (`--global`).

```
holt skill list                       list installed skills
holt skill show <name>                print a skill
holt skill create <name> [--global]   scaffold a new skill
holt skill add <src> [--global]       install from a git URL or local path
holt skill remove <name>              delete a skill
```

In chat, run one with `/skill <name> [your input]`. Available skills are also listed to the brain each turn, so it knows what it can be asked to follow.

## Output format

Replies print as markdown. `/output html` (or `markdown`) switches the save format and persists it. `/save [name]` writes the last reply to the current folder: `.md`, or a small self-contained dark-theme `.html` page.

## Commands

```
holt init            set up (trust, brains, sign-in, defaults) for this folder
holt chat            start a session that remembers past ones
holt graph           see your memory as an interactive knowledge graph
holt skill           manage skills: list | show | create | add | remove
holt memory          inspect memory: holt memory [search <query> | embed | clear]
holt setting         configure brains, API brains, and launch command
holt login <brain>   sign in to claude, codex, or gemini
holt version         print version
holt help            show help
```

## Configuration

`holt init` writes `<folder>/.holt/config.json` (default brain and enabled brains for that folder). Trusted folders live in `~/.holt/trust.json`. Edit settings with `holt setting`.

## Architecture

Small strongly-typed **TypeScript core**, zero runtime dependencies: command dispatch, brain adapters (CLI spawn and direct API streaming), transcript ownership, memory with recall, skills, and the graph renderer. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`CONFIGURATION.md`](./CONFIGURATION.md).

## Roadmap

Built in always-shippable phases toward a full-vision v1:

0. **Skeleton and chat**: trust, init with install and sign-in, chat, brain switching with kept context *(shipped)*
1. **Memory**: per-folder store, semantic recall via local embeddings with keyword fallback, streaming replies *(shipped)*
2. **Any LLM directly**: API brains with your own key, HTML or Markdown output *(shipped)*
3. **Skills**: portable SKILL.md skills, create/add/run *(shipped)*
4. **Knowledge graph**: see and navigate your own memory with `holt graph` *(shipped)*
5. **Orchestration**: a local model works, a cloud model reviews the risky steps
6. **Channels and polish**: Telegram, docs site, skill registry publishing

## Contributing

Holt is built to be extended without touching the core. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Debashis Nayak
