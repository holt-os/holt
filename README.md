# Holt

**Everything you know, kept and connected.**

Holt is an open-source, self-hosted personal agent OS. Clone it, pick your skills, choose your brain, and it runs on *your* machine with persistent memory you can actually see and walk.

> A *holt* is a small wood: a sheltered place where things are kept and grow. That's the idea. A private home for your knowledge that compounds over time.

> **Status: young but genuinely useful.** Working today: `holt init` and `holt chat`, brains as agent CLIs (Claude Code, Codex, Gemini) or direct API connections with your own key, mid-conversation brain switching that keeps context, persistent per-folder memory with semantic recall, skills in the portable SKILL.md format, and `holt graph`: your memory drawn as an interactive knowledge graph.

---

## Install

With Homebrew (installs Node for you, so you do not need npm first):

```bash
brew install holt-os/tap/holt
```

Or with npm, if you already have Node:

```bash
npm install -g @holt-os/holt
```

## Quickstart

```bash
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

When you end a chat, Holt asks the brain to distill 1 to 5 durable facts from the session (decisions, preferences, key names, numbers) and writes them to a human-readable `<folder>/.holt/memory/facts.md` you can read and edit. Those facts are also embedded and ranked slightly higher than raw turns during recall, so the signal rises to the top over time. See them with `holt memory facts`. Turn it off by setting `memory.extractFacts` to `false` in `config.json`.

Two recall modes, picked automatically:

- **Semantic** (best): a local [Ollama](https://ollama.com) with an embedding model, which `holt init` offers to set up for you. Recall matches by meaning: asking "who owns my apartment" finds "my landlord is called Pieter". No API keys, nothing leaves your machine.
- **Keyword** (fallback): with no Ollama, recall matches by word overlap. Still useful, zero setup.

Inspect it any time:

```bash
holt memory                    # stats for this folder
holt memory facts              # show the distilled facts (facts.md)
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

## Use Holt from your other tools (MCP)

Holt can run as an [MCP](https://modelcontextprotocol.io) server, so Claude Code, Cursor, and Codex can recall and remember from Holt's memory for the folder without leaving those tools.

```bash
holt mcp        # run the MCP server for the current folder (talks JSON-RPC over stdio)
holt mcp setup  # print the config snippets for each client
```

The server serves the memory of whatever folder it is launched in. Because MCP is non-interactive (stdin carries the protocol), it cannot prompt for trust, so it **auto-trusts the launch folder** and adds it to `~/.holt/trust.json`. Startup logging goes to stderr; stdout is reserved for the protocol.

Tools it exposes:

- `recall` (`query`, optional `k`): search this folder's memory for relevant moments and facts.
- `remember` (`content`): save a durable fact to this folder's memory.
- `list_skills`: list the skills installed for this folder.
- `get_skill` (`name`): get a skill's full instructions.
- `memory_stats`: memory statistics for this folder.

**Claude Code**

```bash
claude mcp add holt -- holt mcp
```

**Cursor / Codex** (JSON config):

```json
{ "mcpServers": { "holt": { "command": "holt", "args": ["mcp"] } } }
```

Point the client at the folder whose memory you want it to use; Holt serves whatever folder the server process starts in.

## Output format

Replies print as markdown. `/output html` (or `markdown`) switches the save format and persists it. `/save [name]` writes the last reply to the current folder: `.md`, or a small self-contained dark-theme `.html` page.

## Run tasks, schedule them, reach them from your phone

Beyond interactive chat, Holt can run a task once, on a timer, or from Telegram. The selected brain does the task; your memory is recalled into it automatically.

### holt run

Run a single task non-interactively. It recalls relevant memory, injects your skills, runs the brain once, streams the reply, and saves the exchange to this folder's memory.

```bash
holt run "summarize the open items in this folder"
```

Options: `--brain <id>` pick a brain, `--out <file>` also write the reply to a file, `--no-store` skip saving, `--no-recall` skip memory, `--quiet` suppress streaming. The folder must be trusted first (`holt init` or `holt chat` once); in a non-interactive context an untrusted folder exits non-zero instead of prompting.

### holt schedule

Run a task automatically on a timer, using your OS scheduler (launchd on macOS, cron on Linux). A scheduled run behaves exactly like typing `holt run` in that folder.

```bash
holt schedule add "summarize my inbox and flag what is urgent" 07:00 --notify
holt schedule list
holt schedule remove <id>
```

`<HH:MM>` is a 24h daily time. `--notify` pushes the output to your Telegram. Jobs live in `~/.holt/schedules.json`; each run logs to `~/.holt/logs/<id>.log`.

### Telegram: chat with Holt from your phone

Holt can run as a Telegram bot. Messages you send are run through your brain (with memory) and the reply comes back to your phone. Single user: only your chat id is served.

```bash
holt telegram setup   # message @BotFather for a token, paste it, auto-detect your chat id
holt telegram         # run the bot (keep it running under a service manager)
holt notify "backup done"          # push a one-off message
holt run "daily brief" | holt notify   # pipe any output to your phone
```

The token is stored in `~/.holt/telegram.json` (mode 600) and never printed in full.

### holt routine

A routine is a named, reusable job: it bundles the pieces above into one object you can run by name or on a schedule. A routine is a **task source** (an installed skill or an inline prompt) plus an optional **daily schedule** plus **output routing** (stdout, a file, or Telegram). It is the generic version of a recurring "agent" such as a daily brief.

```bash
# an inline task you can rerun by name
holt routine add brief --task "summarize what changed and what is open here" --notify

# a routine backed by an installed skill
holt routine add triage --skill inbox-triage --out triage.md

# a scheduled routine: installs an OS timer that fires "holt routine run digest --quiet"
holt routine add digest --task "digest today's changes" --at 07:00 --notify

# a built-in template (daily-brief or standup)
holt routine add myday --template daily-brief

holt routine run brief          # run it now and stream the reply
holt routine run brief --out b.md   # also write the reply to a file this run
holt routine list               # name, source, schedule, outputs, workspace
holt routine show brief         # full detail
holt routine remove brief       # deletes the routine and its OS timer, if any
```

Sources: give exactly one of `--skill <name>`, `--task "<prompt>"`, or `--template <t>`. A skill routine splices that skill's `SKILL.md` body into the prompt at run time; a task routine uses the prompt as-is.

Scheduling: `--at HH:MM` (24h, daily) installs an OS timer through the same scheduler `holt schedule` uses (launchd on macOS, cron on Linux) whose command is `holt routine run <name> --quiet`. Omit `--at` for a manual, run-on-demand routine. Removing the routine removes its timer.

Output routing: by default the result prints to stdout. `--out <file>` also writes it to a file (relative to the routine's workspace); `--notify` pushes it to Telegram (guarded cleanly when Telegram is not set up). Both `--out` and `--notify` can also be passed to `holt routine run` for a single run. In `--quiet` mode (what the scheduler uses) stdout is suppressed but `--out` and `--notify` still fire.

Routines are stored in `~/.holt/routines.json` (one entry per routine, each carrying its absolute workspace). A routine with a schedule also produces an entry in `~/.holt/schedules.json`, keyed by the routine name; the two are kept consistent.

## Commands

```
holt init            set up (trust, brains, sign-in, defaults) for this folder
holt chat            start a session that remembers past ones
holt run <task>      run one task non-interactively (recall, brain, remember)
holt schedule        run a task on a timer: add | list | remove
holt routine         named, reusable, scheduled jobs: add | run | list | show | remove
holt telegram        chat with Holt from your phone: telegram [setup]
holt notify [msg]    push a message to your phone over Telegram (stdin-friendly)
holt graph           see your memory as an interactive knowledge graph
holt mcp             run an MCP server so other tools use this folder's memory (holt mcp setup)
holt skill           manage skills: list | show | create | add | remove
holt memory          inspect memory: holt memory [search <query> | facts | embed | clear]
holt setting         configure brains, API brains, and launch command
holt login <brain>   sign in to claude, codex, or gemini
holt version         print version
holt help            show help
```

## Configuration

`holt init` writes `<folder>/.holt/config.json` (default brain and enabled brains for that folder). Trusted folders live in `~/.holt/trust.json`. Edit settings with `holt setting`. Scheduled jobs live in `~/.holt/schedules.json`, and the Telegram token in `~/.holt/telegram.json` (mode 600).

## Architecture

Small strongly-typed **TypeScript core**, zero runtime dependencies: command dispatch, brain adapters (CLI spawn and direct API streaming), transcript ownership, memory with recall, skills, and the graph renderer. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`CONFIGURATION.md`](./CONFIGURATION.md).

## Roadmap

Built in always-shippable phases toward a full-vision v1:

0. **Skeleton and chat**: trust, init with install and sign-in, chat, brain switching with kept context *(shipped)*
1. **Memory**: per-folder store, semantic recall, streaming replies, and distilled facts per session *(shipped)*
2. **Any LLM directly**: API brains with your own key, HTML or Markdown output *(shipped)*
3. **Skills**: portable SKILL.md skills, create/add/run *(shipped)*
4. **Knowledge graph**: see and navigate your own memory with `holt graph` *(shipped)*
5. **Everywhere**: MCP server so other tools read Holt's memory, plus `holt run`, scheduling, and Telegram *(shipped)*
6. **Next**: docs site, skill registry publishing, more channels

## Contributing

Holt is built to be extended without touching the core. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Debashis Nayak
