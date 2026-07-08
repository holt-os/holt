# Holt

**Everything you know, kept and connected.**

Holt is an open-source, self-hosted personal agent OS. Clone it, pick your skills, choose your brain, and it runs on *your* machine with persistent memory you can actually see and walk.

> A *holt* is a small wood: a sheltered place where things are kept and grow. That's the idea. A private home for your knowledge that compounds over time.

> **Status: shipping and usable today.** Working now:
>
> - `holt init` + `holt chat` with any brain (Claude Code, Codex, Gemini, or a direct API key), and mid-conversation brain switching that keeps context.
> - Per-folder memory with semantic recall and distilled facts, ambient memory for Claude Code (`holt hook`), and opt-in memory shared across folders (`holt memory global`).
> - A self-maintaining knowledge wiki (`holt wiki`) and an interactive knowledge graph (`holt graph`) that can also ingest your code and docs into communities.
> - Run a task once, on a schedule, or as a named routine (`holt run` / `schedule` / `routine`), and reach it from your phone over Telegram.
> - Draft in your own voice with anti-AI checks (`holt write`), and size your setup with `holt doctor`.
> - Ten built-in skills plus a community registry (`holt skill search`), and an MCP server so Claude Code, Cursor, or Codex can read this folder's memory.

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
/allow <path>     let this session read a folder outside this one (session-only)
/allowed          list folders granted outside-access this session
/setting          configure brains, API brains, and your launch command
/clear            forget this session (saved memory stays)
/help             show commands
/exit             leave
```

A line that starts with `/` is treated as a command only when its first word is a real command. So a message like `/Users/me/resume.docx summarize this` (or a URL, or any sentence that opens with a slash) is sent to the brain as-is, never dropped as an "unknown command".

The point of `/brain`: Holt owns the transcript, so you can start a thread on one model and hand it to another mid-conversation. The new brain picks up with the full context.

### Reading files outside this folder

Holt runs the brain in the folder you launched it from, so by default the brain only sees this folder. If a message references an absolute path (`/...` or `~/...`) that exists **outside** the folder, Holt asks first: `Allow this session to access <dir> (outside this folder)? [y/N]`. Answer `y` and it grants the file's **containing directory** read access for the rest of this chat. Answer `n` and the message still goes through, the brain just does not get that folder.

- `/allow <path>` grants a folder up front with no prompt.
- `/allowed` lists what you have granted.

Grants are **in-memory and session-scoped**: nothing is written to disk, and they reset the next time you run `holt chat`. Access is **read-oriented** and only works with a **Claude Code** brain: Holt passes `--add-dir=<dir>` for each granted folder plus `--allowedTools=Read,Glob,Grep` so Claude Code can read (but not write) those files without an interactive permission prompt. With a Codex/Gemini or API brain, external file access is unavailable and Holt says so instead of adding flags. (If you need to tune the flags, they live in one place: `claudeAccessArgs` in `src/access.ts`.)

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
holt memory global             # share high-value facts across your folders
holt memory clear              # wipe this folder's memory
```

Turns saved before semantic memory was enabled are upgraded in one pass with `holt memory embed`.

Long conversations stay cheap: only recent turns are replayed verbatim, older context comes back through recall.

### Optional global memory (`holt memory global`)

By default every folder's memory is **isolated**: recall never crosses folders. If you want a folder to draw on what you learned elsewhere, opt it into a shared store:

```bash
holt memory global on          # this folder now contributes + reads shared facts
holt memory global status      # who is sharing, and global store stats
holt memory global off         # stop sharing + reading (recall goes local-only)
holt memory global off --purge # also delete this folder's rows from the store
```

What opting in does:

- **Facts only.** Only distilled facts (the `fact` rows, which includes wiki pages) are promoted, never raw turns. Each promoted fact is **tagged with the absolute path of the folder it came from**, so you always know its origin.
- **One switch = contribute + read.** An opted-in folder both pushes its facts to the shared store and, during recall, also scores the shared store and merges the hits, so `holt memory search` and chat recall surface knowledge from your *other* opted-in folders. Your own folder's rows are excluded from the global read (they are already in local memory, so there is no double counting). Global hits are shown tagged with their source folder.
- **`on` backfills** the folder's existing facts, then new facts mirror automatically. Saving the same fact twice does not duplicate it (dedup by normalized content + folder).

Everything lives outside your projects, so a folder that never opts in is completely unaffected:

- **Store:** `~/.holt/global/turns.jsonl`, one row per promoted fact plus a `workspace` field.
- **Registry:** `~/.holt/memory-scopes.json`, shape `{ "enabled": ["<abs folder path>", ...] }`. This is the whole list of folders that participate. Per-folder `config.json` is not touched.

A missing or corrupt global store degrades silently to local-only recall. Per-folder isolation stays the default.

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

Options: `--out <path>` to write elsewhere, `--no-open` to skip the browser. When a wiki exists (see below), the graph auto-includes wiki pages as green nodes wired by their `[[links]]`; force it on or off with `--wiki` / `--no-wiki`. This is the graph as a view over your wiki.

### Richer graph: code, docs, and communities

Plain `holt graph` is unchanged: it draws this folder's memory (plus the wiki when one exists). To also see the folder's *own source and docs* as a graph, opt in with flags:

- `holt graph --code` walks the folder and adds a node per source file (orange), with dependency edges from the imports it can resolve.
- `holt graph --docs` adds a node per doc (blue: `.md` / `.mdx` / `.txt` / `.rst`), with edges from Markdown links and `[[wikilinks]]` between them.
- `holt graph --all` does both. All three still render the memory + wiki graph too, so code, docs, and memory sit in one picture.

**What gets ingested.** The walk skips `node_modules`, `.git`, `.holt`, `dist`, `build`, `.next`, `coverage`, other build/vendor dirs, and any dotfolder. It caps out at 2000 files and 400KB per file for safety, and logs what it skipped. Code files (`js`, `ts`, `jsx`, `tsx`, `mjs`, `cjs`, `py`, `go`, `rb`, `rs`, `java`, and more) become file nodes. Dependency edges are best-effort per language: for JS/TS it reads `import ... from`, `export ... from`, `require()`, and dynamic `import()`, resolving only *relative* specifiers (`./`, `../`) to files in the set (trying common extensions and `index.*`); bare/package imports (`react`, `node:fs`) are intentionally dropped. For Python it maps `import x` and `from x import ...` to local module files where they resolve. Unresolved imports are silently dropped, never fatal.

**Communities.** Once code or docs are ingested, Holt runs **label propagation** (a deterministic, zero-dependency community-detection algorithm) over the whole graph and tints each node's ring by its community, so tightly-coupled files cluster visibly. (Label propagation was chosen over Louvain because it is near-linear, trivially deterministic in stable node order, and keeps the code tiny.)

### God-node report: `holt graph report`

`holt graph report` ingests this folder's code and docs, detects communities, and writes a `GRAPH_REPORT.md` (use `--out <path>` to write elsewhere). The report summarizes node / edge / community counts, lists the **god nodes** (highest-degree files: your core abstractions) with their community, and gives a per-community summary (size + representative files). It is safe on an empty folder (it says so, no crash). This is the graphify-grade view of a codebase, generated natively in TypeScript with zero dependencies.

## Knowledge wiki: `holt wiki`

Memory has three layers, each derived from the one below it:

1. **Raw turns** (`turns.jsonl`): every exchange, append-only, authoritative.
2. **Facts** (`facts.md`): 1 to 5 durable facts distilled per session.
3. **Wiki** (`.holt/wiki/`): a cross-linked set of Markdown pages, synthesized and maintained by an LLM. This is the "kept and connected" layer.

The core rule: **wiki pages are derived and regenerable, never a sole source of truth.** Turns and facts stay authoritative. Every page records which fact ids it drew from (frontmatter `sources:`), so `holt wiki rebuild` can regenerate the whole wiki from scratch. A bad synthesis is therefore never lossy: rebuild recovers it. Pages are plain Obsidian-compatible Markdown with `[[wikilinks]]` and an `index.md`, so you can point Obsidian at `.holt/wiki` as a vault, or edit pages by hand (a rebuild will overwrite hand-edits, so keep the folder under git if you edit).

```bash
holt wiki                     # status: maintainer, model, auto-sync, page count, last sync, RAM hint
holt wiki sync                # fold new facts into pages (route + merge)
holt wiki auto [on|off]       # auto-sync the wiki when a session ends (wiki.autoSync)
holt wiki rebuild             # wipe and regenerate every page from facts (asks first)
holt wiki lint [--fix]        # audit for contradictions, duplicates, gaps; --fix applies the fixes
holt wiki list                # list pages (title, updated, size)
holt wiki show <page>         # print one page
holt wiki open                # open the wiki in your default app (Obsidian reads it natively)
holt wiki setup               # recommend a local model for this machine's RAM
```

**How sync works.** `holt wiki sync` gathers facts added since the last sync (a marker in `.holt/wiki/.state.json`), embeds each one locally, and routes it to the nearest existing page by cosine similarity. Related facts land on the same page; a fact that matches nothing new starts a fresh page. Facts are grouped by target page and the maintainer is called **once per changed page** (not once per fact), so it only rewrites the few pages that actually changed. Routing is always local and free, which is what keeps the maintainer's cost minimal. `holt wiki rebuild` folds every fact from scratch.

**Self-maintaining (auto-sync).** Turn on `holt wiki auto on` (persists `wiki.autoSync: true` for the folder) and the wiki keeps itself current with no manual command. It syncs **after fact distillation** at the end of a `holt chat` session, and ambiently when the Claude Code **Stop** hook fires (`holt hook capture`), so newly captured facts fold straight into pages. Auto-sync is silent, best-effort, and never blocks exit: it reuses the exact same sync engine as `holt wiki sync`, so there is no behavior drift. Left off (the default), nothing changes and you sync by hand. `holt wiki auto` with no argument shows the current state; `holt wiki status` surfaces it too.

**Lint that can fix.** `holt wiki lint` audits pages for contradictions, duplicates, and gaps and prints a report only (files untouched). Add `--fix` and Holt asks the maintainer to return corrected page bodies and **applies them**, rewriting the affected pages (provenance/`sources` is preserved). Because pages are derived and regenerable, applying is safe: a bad `--fix` is fully recoverable with `holt wiki rebuild`, and the command prints a git/backup nudge before writing. Only pages that actually change are rewritten.

**Who maintains it (the key knob).** Synthesis is a reasoning task, and you choose who does it with `wiki.maintainer`:

- `brain` (default): the folder's configured brain, exactly like fact distillation. When the brain is the Claude Code CLI this rides your existing Claude plan, so there are no marginal dollars per sync.
- `local`: a local generative model via Ollama (set `wiki.localModel`, default `qwen2.5:7b`). Free and offline, lower quality, and it trades dollars for RAM. If the model is not pulled, Holt prints the exact `ollama pull` line and falls back to the brain rather than failing.

`holt wiki setup` (or the hint in `holt wiki status`) reads your total RAM and recommends a model: under 16 GB it discourages local (use the brain); 16 GB suggests `qwen2.5:7b` (tight alongside the embed model, an always-on machine is a better host); 24 to 32 GB suggests `qwen2.5:14b`; 48 GB and up suggests `qwen2.5:32b`.

Wiki pages also participate in recall: each page is embedded and indexed like a high-value fact, so `holt memory search` and chat recall can surface synthesized knowledge, not just raw turns.

## Skills

A skill is a folder with a `SKILL.md`: YAML frontmatter (`name`, `description`) plus Markdown instructions. Same convention as agentskills.io and Claude Code, so skills are portable both ways. Skills are prompt text only; Holt never executes their contents.

Holt looks in three places, in precedence order (workspace shadows global shadows builtin on a name clash): `./.holt/skills/` for this folder, `~/.holt/skills/` for every folder (`--global`), and a read-only set of **built-in skills** that ship inside Holt and are available in every folder out of the box.

```
holt skill list                        list installed skills
holt skill show <name>                 print a skill
holt skill create <name> [--global]    scaffold a new skill
holt skill search <query>              find skills in the registry
holt skill add <src|name> [--global]   install from a git URL, git-url#subdir, path, or registry name
holt skill publish [<name>]            prepare a skill for the registry (prints a PR entry)
holt skill remove <name>               delete a skill
```

A source may carry a `#<subdir>` suffix (split on the first `#`) that points at one skill folder inside a repo or path: `holt skill add https://github.com/holt-os/registry#skills/pm-prd`. The subdir is a path, relative to the source root, that contains a `SKILL.md`. This lets a single repo hold many skills (one monorepo), which is exactly how the community registry is laid out. The subdir is validated to stay inside the source (absolute paths and `..` traversal are refused), since a registry entry is remote-controlled. Without a `#`, behaviour is unchanged: Holt looks for a `SKILL.md` at the source root or in exactly one immediate subfolder.

In chat, run one with `/skill <name> [your input]`. Available skills are also listed to the brain each turn, so it knows what it can be asked to follow.

### Built-in skills

Holt ships with a small, curated set of general-purpose skills, available in every folder with no setup. They are read-only (`holt skill remove` will not delete them); to change one, create a workspace or global skill with the same name and it takes over.

- **summarize**: condense a document, article, transcript, or pasted text into its key points.
- **explain**: explain a concept, error message, or piece of jargon in plain language.
- **action-items**: pull decisions, tasks, and owners out of messy notes or a meeting transcript.
- **brief**: a short briefing on the state of the current folder, using recalled memory plus your input.
- **code-review**: review a file or a diff for correctness bugs, edge cases, and simplifications.
- **explain-code**: walk through what a file or function does and how it fits into the wider system.
- **commit**: draft a clear commit message from staged changes or a described change.
- **plan**: break a goal into a concrete, ordered set of steps.
- **rewrite**: tighten and clarify a piece of text without changing its meaning.
- **decide**: weigh a decision and give a clear recommendation.

### Skill registry (`holt skill search` / `publish`)

Beyond pasting URLs, Holt can discover and share skills through a **git-based registry**: a single JSON index living in a git repo. No server, no infra, in keeping with the rest of Holt.

The index is a JSON document:

```json
{
  "version": 1,
  "skills": [
    {
      "name": "hello-registry",
      "description": "A tiny demo skill.",
      "source": "https://github.com/you/hello-registry.git",
      "author": "you",
      "tags": ["demo"]
    }
  ]
}
```

`source` is anything `holt skill add` already accepts: a git URL (its `SKILL.md` may sit in one subfolder), a local path, or either of those with a `#<subdir>` suffix pointing at one skill folder inside the repo. That last form lets one repo hold many skills, so the community registry can be a single monorepo (e.g. `"source": "https://github.com/holt-os/registry#skills/pm-prd"`). `tags` is optional. Only `name` and `source` are required per entry; malformed rows are skipped rather than failing the whole index.

- **Find:** `holt skill search <query>` fetches the index and lists skills whose name, description, or tags match (case-insensitive substring, name matches first). An empty query lists everything. It prints name, author, description, and source.
- **Install by name:** `holt skill add <name>` resolves the name in the registry to its `source`, then installs through the exact same clone/copy path as `holt skill add <url|path>`. A git URL or an existing local path is still installed directly, unchanged.
- **Publish (zero-infra):** `holt skill publish [<name>]` validates a skill's `SKILL.md` (needs a `name` and `description`) and prints the exact JSON entry plus instructions to open a PR against the community registry repo. Holt never pushes anywhere; you add the entry via a pull request. With no name, it publishes the `SKILL.md` in the current directory.

The default index is the community registry (`https://raw.githubusercontent.com/holt-os/registry/main/registry.json`). Override it with `HOLT_REGISTRY_URL` (a URL, a `file://` URL, or a plain path) to point at your own index or a local file. The fetched index is cached at `~/.holt/registry-cache.json` for one hour; `--refresh` forces a re-fetch. If no registry is reachable (for example, the community index is not live yet), search and install-by-name fail cleanly with a clear message rather than crashing.

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

## Ambient memory for Claude Code (`holt hook`)

The MCP server above lets Claude Code recall and remember **when it decides to**. `holt hook` goes further: it makes Holt's per-folder memory work **ambiently**, with no `holt chat` and no manual tool call. Two directions, both wired as [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks):

- **Inject** (`UserPromptSubmit`): before each prompt, Holt quietly recalls the most relevant remembered notes for the current folder and adds them to the model's context.
- **Capture** (`Stop`): when a session ends, Holt distills durable facts from the transcript (via this folder's configured brain) and saves them to the folder's memory.

```bash
holt hook install                 # install both hooks into ~/.claude/settings.json
holt hook install --inject-only   # only the before-prompt recall hook
holt hook install --capture-only  # only the end-of-session fact hook
holt hook install --project       # write ./.claude/settings.json instead of the global one
holt hook status                  # show what is installed and which directions are active
holt hook remove                  # remove ONLY Holt's hooks, leaving everything else intact
```

Install **merges** into any existing `hooks` config, never clobbers unrelated settings or other hooks, is **idempotent** (re-running does not duplicate), and backs the file up to `settings.json.holt-bak` before writing. `remove` deletes only the entries whose command is `holt hook inject` / `holt hook capture`.

**Trusted-folder guard (important).** The two runtime hooks (`holt hook inject` and `holt hook capture`, invoked by Claude Code, not you) no-op **silently** unless the folder is a trusted Holt workspace with an existing `.holt/memory`. So Holt never injects your private notes into an unrelated project, and never creates memory in a folder you never set up. To make a folder ambient, run `holt init` (or `holt chat`) there once so it becomes trusted and gets its `.holt/memory`. The inject hook keeps stdout clean (only the context block is printed, since Claude Code injects it verbatim); all diagnostics go to stderr, and both hooks always exit 0 so a memory step never blocks or slows your prompt.

**Seeing what the hooks did (`~/.holt/hooks.log`).** Since the hooks stay silent, every `holt hook capture` run appends **one** line to `~/.holt/hooks.log` with the outcome or the exact skip reason (untrusted folder, no config, `extractFacts` off, no usable brain, missing or empty transcript, too few exchanges, or `saved N facts`), preceded by a line of the raw hook fields it received. Check this file first if capture seems to save nothing. `inject` uses the same log but stays quiet by default; set `HOLT_HOOK_DEBUG=1` to make it log too.

To uninstall, run `holt hook remove` (add `--project` if you installed with `--project`).

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

## Machine check (`holt doctor`)

Not sure how best to run Holt on your hardware? `holt doctor` looks at this machine and its installed tools and tells you, in plain language, what to do.

```bash
holt doctor
```

It reports, section by section:

- **Machine**: platform, CPU, RAM (total and free), and Node version.
- **Brains**: which agent CLIs (`claude`, `codex`, `gemini`) are installed, plus a recommendation (prefer an installed CLI brain; otherwise install one or add an API brain).
- **Semantic memory**: whether a local Ollama with the embed model is reachable, and how to enable it (`ollama pull nomic-embed-text`) so recall is semantic and fully private.
- **Knowledge wiki maintainer**: `brain` (the default, best quality, rides your existing plan) versus a local model sized to your RAM. On a 16 GB machine it names `qwen2.5:7b`; more RAM gets a larger model; under 16 GB it steers you to `brain`.
- **Always-on / Telegram**: whether a Telegram bot is set up, and a note on hosting the bot on a low-power always-on machine while keeping heavy local models on a bigger one.
- **Recommended next steps**: a short checklist built from whatever gaps it found.

It is read-only advice: it changes nothing, needs no trust, and always exits cleanly even when a probe fails.

The RAM-to-model table lives in `src/specs.ts` (`LOCAL_MODEL_RECS` / `recommendLocalModel`), the single source of truth the wiki maintainer reads too.

## Your writing voice (`holt voice` + `holt write`)

Holt can learn how *you* write, then draft in that voice while steering clear of the patterns that make text read as machine written.

### Teach it your voice: `holt voice`

At the end of `holt init` you are offered a short optional interview. You can also run or redo it anytime:

```bash
holt voice            # run the interview, or add samples, or both
holt voice add <file> # learn from a writing sample you already have
holt voice show       # print your profile
holt voice edit       # show where the profile lives (it is a plain JSON file)
holt voice clear      # remove it
```

The interview asks you to pick a **depth** up front: `quick` (a few questions) or `detailed` (more). Questions are about **writing and communication style only**: tone, sentence length, first vs third person, emoji habits, words you love or ban, who you write for, and what you want to sound like and not sound like.

Changed your mind at the first prompt? Answer `n`, `skip`, `cancel`, or just press enter to back out cleanly. Nothing is saved and no profile is built; run `holt voice` again whenever you like. Inside the question list, an empty answer skips only that one question.

Privacy is a hard rule. The interview never asks for personal details (no name, job, location, or life story). If you happen to mention something personal in an answer, Holt stores only what you typed and never asks follow ups.

You can also feed it real writing. `holt voice add <file>` reads a file; inside the interview you can paste a sample instead. Samples are stored as a hash and length by default; an excerpt is kept only if you say yes, so Holt can match your rhythm directly.

From the answers and samples, Holt asks your configured brain to build a **style profile**: tone, formality (1 to 5), average sentence length, person, emoji and formatting habits, signature moves, banned words, target audiences, and a short "sounds like / does not sound like" summary. If no brain is set yet, your raw answers are saved and the profile synthesizes the next time you run `holt voice` with a brain configured.

The profile lives at `~/.holt/voice.json` (mode 600, since it can hold writing excerpts). It is global to you, not per folder, and you can hand edit it.

### Draft in your voice: `holt write`

```bash
holt write "a linkedin post about shipping Holt" --type linkedin
holt write "a reply to a customer asking for a refund" --type email --out reply.txt
holt write "a short post about testing" --fast
```

`holt write` composes three things into one prompt: your voice profile, a built in **anti-AI rubric**, and your request. Then it runs your default brain. `--type` shapes length and format (`linkedin`, `email`, `tweet`, `blog`, `generic`), `--out` also writes the draft to a file, and `--brain <id>` picks a brain.

By default a second pass checks the draft against the rubric and fixes any tells; `--fast` skips it for a single call. The anti-AI rubric bans em-dashes, "rule of three" cliches, "in today's fast-paced world" openers, "it is not X, it is Y" reframes, tidy bow-tie conclusions, uniform sentence rhythm, hedging filler, corporate buzzwords, and emoji unless your profile allows them. The output is always em-dash free.

With no profile yet, `holt write` still works using a plain, natural voice.

## Commands

```
holt init            set up (trust, brains, sign-in, defaults) for this folder
holt chat            start a session that remembers past ones
holt run <task>      run one task non-interactively (recall, brain, remember)
holt schedule        run a task on a timer: add | list | remove
holt routine         named, reusable, scheduled jobs: add | run | list | show | remove
holt telegram        chat with Holt from your phone: telegram [setup]
holt notify [msg]    push a message to your phone over Telegram (stdin-friendly)
holt doctor          check this machine and recommend how best to run Holt here
holt voice           teach Holt your writing voice: add <file> | show | edit | clear
holt write <what>    draft content in your voice with anti-AI checks (--type, --out, --fast)
holt graph           see your memory as an interactive knowledge graph
                     (--code / --docs / --all to ingest this folder's code + docs;
                      "holt graph report" writes GRAPH_REPORT.md)
holt mcp             run an MCP server so other tools use this folder's memory (holt mcp setup)
holt hook            ambient memory for Claude Code: install | remove | status
holt skill           manage skills: list | show | create | add | remove
holt memory          inspect memory: holt memory [search <query> | facts | embed | clear]
holt wiki            derived knowledge wiki: holt wiki [sync | auto | rebuild | lint | list | show | status]
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
6. **Knowledge wiki**: LLM-maintained, cross-linked, regenerable pages over your memory with `holt wiki` *(shipped)*
7. **Next**: docs site, skill registry publishing, more channels

## Contributing

Holt is built to be extended without touching the core. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Debashis Nayak
