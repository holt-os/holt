# Configuration

Holt keeps configuration in plain files you can read and edit. There are two: a global trust list and a per-folder config. Memory and the derived wiki are stored per folder too. This page documents every real knob.

Normally you never edit these by hand. `holt init` writes them, and `holt setting` changes them. Editing them directly works fine if you know what you want.

## Per-folder config: `<folder>/.holt/config.json`

Written by `holt init` in the folder you ran it from. It records which brains are enabled in that folder and which one is the default. Annotated example:

```json
{
  "version": 5,
  "defaultBrain": "claude",
  "brains": {
    "claude": {
      "id": "claude",
      "label": "Claude Code",
      "command": "claude",
      "args": ["-p"],
      "enabled": true
    },
    "codex": {
      "id": "codex",
      "label": "Codex (OpenAI)",
      "command": "codex",
      "args": ["exec"],
      "enabled": false
    },
    "gemini": {
      "id": "gemini",
      "label": "Gemini CLI",
      "command": "gemini",
      "args": ["-p"],
      "enabled": false
    }
  },
  "apiBrains": [],
  "outputFormat": "markdown",
  "memory": { "extractFacts": true },
  "wiki": { "maintainer": "brain", "localModel": "qwen2.5:7b" }
}
```

- `version` (number): config schema version. Currently `5`. Holt fills in missing fields from defaults when it loads an older file, so upgrading is lossless: a v4 file (no `wiki` block) loads as v5 with the wiki defaults filled in and every existing field preserved.
- `defaultBrain` (string | `null`): the brain a new `holt chat` starts with: a CLI brain id (`claude`/`codex`/`gemini`) or the short name of an API brain. `null` means no brain is ready.
- `brains` (map): one entry per known brain.
  - `id`: the brain key, same as the map key.
  - `label`: display name shown in the UI.
  - `command`: the CLI Holt runs. Must be on your `PATH`.
  - `args`: the non-interactive flags passed before the prompt. Holt invokes `command args... "<prompt>"` once per turn.
  - `enabled`: whether this brain is selectable in this folder. Set true only when the command is installed.

- `apiBrains` (array): direct provider connections added via `holt setting` or `holt init`. Each entry: `id` (your short name), `provider` (`anthropic` | `openai` | `gemini`), `model` (free text), optional `keyEnv` (name of an env var holding the key). Key resolution order: `keyEnv`, then `~/.holt/credentials.json`, then the provider standard env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`).
- `outputFormat` (`"markdown"` | `"html"`): how `/save` writes replies. Toggle in chat with `/output`.
- `memory` (object): memory behavior. `extractFacts` (boolean, default `true`): when true, Holt distills 1 to 5 durable facts from the transcript when a chat session ends and saves them to `facts.md` plus the recall index. Set it to `false` to disable fact distillation entirely.
- `wiki` (object): the derived knowledge wiki (see `holt wiki`).
  - `maintainer` (`"brain"` | `"local"`, default `"brain"`): who synthesizes and merges pages. `brain` uses the folder's configured brain (rides your Claude plan when the brain is the Claude CLI, so no marginal cost). `local` uses a local Ollama generative model, which is free and offline but lower quality (it trades dollars for RAM).
  - `localModel` (string, default `"qwen2.5:7b"`): the Ollama generative model used when `maintainer` is `"local"`. This is a text model, distinct from the embed model (`nomic-embed-text`) used for routing and recall. If it is not pulled, `holt wiki` prints the `ollama pull` line and falls back to the brain. `holt wiki setup` recommends a model for your RAM.
  - `autoSync` (boolean, optional, default off): when `true`, the wiki keeps itself current with no manual `holt wiki sync`. After a `holt chat` session ends, Holt distills facts and then folds them into pages automatically; the Claude Code Stop hook (`holt hook capture`) does the same ambiently, so facts captured with no chat still reach the wiki. Auto-sync is silent, best-effort, and never blocks exit, and it reuses the same engine as `holt wiki sync` (no behavior drift). Toggle it with `holt wiki auto on` / `holt wiki auto off` (which write this field); `holt wiki status` and `holt wiki auto` show the current state.

To point a brain at a different CLI or add flags, edit `command` / `args`. See the echo-brain trick in `CONTRIBUTING.md` for a testing use of this.

## Stored API keys: `~/.holt/credentials.json`

Written only when you paste a raw key while connecting an API brain. One optional key per provider (`anthropic`, `openai`, `gemini`), file mode `600`. Prefer env vars if you rotate keys often; delete the file to forget every stored key.

## Writing voice profile: `~/.holt/voice.json`

Your writing voice, built by `holt voice` and used by `holt write`. It is **global to you**, not per folder, so the same voice follows you everywhere. File mode `600`, because it can hold excerpts of your own writing. It is a plain JSON file you can hand edit; after changing `answers` or `samples`, run `holt voice` to re-synthesize the `style`.

Privacy is a hard rule: the interview only ever asks about writing and communication style, never personal details. Samples are stored as a hash and length by default; an excerpt is kept only if you consent when adding it.

```json
{
  "version": 1,
  "depth": "quick",
  "answers": [
    { "key": "tone", "question": "What tone...", "answer": "casual and dry" }
  ],
  "samples": [
    { "source": "file:/path/to/note.md", "hash": "a1b2c3d4e5f6a7b8", "length": 812, "excerpt": "...", "storedFull": true, "addedAt": 1719878400000 }
  ],
  "style": {
    "tone": "casual, dry",
    "formality": 2,
    "avgSentenceLength": "short",
    "person": "first",
    "emoji": "rare",
    "formatting": "short paragraphs, no headers",
    "signatureMoves": ["opens with a concrete moment"],
    "bannedWords": ["leverage", "synergy"],
    "targetAudiences": ["builders", "peers"],
    "soundsLike": "a smart friend over coffee",
    "doesNotSoundLike": "a press release"
  },
  "synthesizedAt": 1719878400000
}
```

- `answers` are the raw interview responses (style only). `samples` reference writing you shared; `excerpt` is present only with your consent.
- `style` is synthesized by your configured brain from the answers and samples. If no brain is set, the raw answers are saved and a `synthesisNote` explains that the profile builds once a brain is configured.
- `holt write` composes `style` (plus any stored excerpts) with a generic anti-AI rubric and your request, then runs your default brain. A second self-check pass fixes any tells unless you pass `--fast`. Generated output is always em-dash free.
- Remove the profile with `holt voice clear` (the file is overwritten then deleted so no excerpt lingers).

## Skill scopes: builtin, global, workspace

A skill is a folder with a `SKILL.md` (YAML `name` + `description`, then Markdown instructions). Holt discovers skills from three scopes, listed here from lowest to highest precedence:

- **builtin**: a read-only, curated set that ships **inside the Holt package** (at `<package-root>/skills/`, resolved from Holt's own module location so it works both installed and in dev). These are available in every folder with no setup. They cannot be created, added, or removed by the skill commands: `holt skill remove <builtin>` refuses with a clear message, and `holt skill create` / `holt skill add` only ever write to the workspace or global scope, never into the package.
- **global**: your personal skills at `~/.holt/skills/`, available in every folder. Install or scaffold with the `--global` flag.
- **workspace**: this folder's skills at `./.holt/skills/`. The default target for `holt skill create` / `holt skill add`.

Precedence is **workspace > global > builtin**: on a name clash the workspace copy wins, then global, then builtin. So you can override any built-in skill simply by creating a workspace or global skill with the same name; it takes over in `holt skill list`, `holt skill show`, and `/skill <name>`. Delete that override and the built-in one returns.

## Global trust list: `~/.holt/trust.json`

The one global file. It lists the absolute paths of folders you have trusted. Holt refuses to read or write in a folder that is not in this list until you approve it.

```json
{
  "trusted": [
    "/Users/you/projects/notes",
    "/Users/you/work/client-x"
  ]
}
```

Remove a path here to un-trust that folder; Holt will ask again next time you run a command there.

## MCP server: `holt mcp`

`holt mcp` runs Holt as an [MCP](https://modelcontextprotocol.io) server over stdio, so other tools (Claude Code, Cursor, Codex) can use this folder's memory. It exposes five tools: `recall`, `remember`, `list_skills`, `get_skill`, and `memory_stats`. Run `holt mcp setup` to print the client config snippets.

The server operates on the folder its process starts in, exactly like `holt chat`. MCP is non-interactive (stdin carries the JSON-RPC protocol), so it cannot prompt for trust: it **auto-trusts the launch folder** and adds it to `~/.holt/trust.json`. In server mode stdout is the protocol channel; any log line goes to stderr instead.

## Ambient memory hooks: `holt hook`

`holt hook install` wires Holt into Claude Code so per-folder memory works ambiently, with no `holt chat` and no manual tool call. It edits Claude Code's `settings.json` to register two [hooks](https://docs.claude.com/en/docs/claude-code/hooks):

- **inject** on the `UserPromptSubmit` event, running `holt hook inject`: before each prompt, recall the top notes for the current folder and print them so Claude Code adds them to context.
- **capture** on the `Stop` event, running `holt hook capture`: when a session ends, distill durable facts from the transcript (via the folder's configured brain) and save them to the folder's memory.

Management commands:

- `holt hook install` writes both hooks. `--inject-only` / `--capture-only` narrow it. `--project` writes `./.claude/settings.json` instead of the default global `~/.claude/settings.json` (created if missing).
- `holt hook remove` removes **only** Holt's entries (identified by the `holt hook inject` / `holt hook capture` command). Add `--project` to scope to the project file. Everything else in the file is preserved.
- `holt hook status` reports the installed state (global and project) and which directions are active.

Install **merges** into any existing `hooks` config, is **idempotent** (re-running never duplicates an entry), and copies the file to `settings.json.holt-bak` before writing.

**Trusted-folder guard.** The runtime bodies (`holt hook inject`, `holt hook capture`) are invoked by Claude Code, not you. They no-op **silently** in any folder that is not a trusted Holt workspace (`~/.holt/trust.json`) with an existing `.holt/memory`. Holt never injects private notes into unrelated projects and never creates memory in folders you did not set up. Run `holt init` (or `holt chat`) in a folder once to make it eligible. The inject hook writes **only** the context block to stdout (Claude Code injects it verbatim); all diagnostics go to stderr, and both hooks always exit 0. `capture` also respects the `memory.extractFacts` config flag and does nothing if no brain is configured. Uninstall with `holt hook remove`.

**Throttled re-distill.** Claude Code fires `Stop` after every assistant response, so `capture` is **throttled**: once a session passes the 3-exchange minimum it re-distills only when the session has gained a couple of new exchanges since the last capture (it skips with a `throttled` log line otherwise). Per-session progress lives in `~/.holt/hook-state.json` (`{ "<session_id>": { "lastExchanges": N } }`); a missing or corrupt file is treated as empty and never blocks capture. Sessions with no `session_id` are processed but not tracked.

**Activity log: `~/.holt/hooks.log`.** Because the hooks are silent by design, every `holt hook capture` run appends **one** line to `~/.holt/hooks.log` recording the outcome or the exact reason it did nothing (no trusted `.holt/memory`, no config, `extractFacts` off, no usable brain, missing or empty transcript, too few exchanges, throttled, or `saved N facts`), preceded by one line of the raw hook fields it saw. This is the place to look when capture seems to save nothing. `inject` shares the same log but stays quiet by default (it fires on every prompt); set the environment variable `HOLT_HOOK_DEBUG=1` to make `inject` log too. The file is created on demand and never grows unbounded per run (one or two lines per invocation); delete it any time.

If capture logs `no usable brain (... whichFound=false resolvedPath=none)`, the folder's brain CLI is not reachable from the hook's environment; capture already tries your login shell and common install dirs (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `/usr/bin`, `/bin`) to find an absolute path, so `resolvedPath=none` means it truly could not locate the binary.

## Routines: `~/.holt/routines.json`

A routine is a named, reusable job: a **task source** (an installed skill or an inline prompt) plus an optional **daily schedule** plus **output routing** (stdout, a file, or Telegram). It is the bundle of `holt skill` / `holt run` / `holt schedule` / `holt notify` under one name, and is the generic version of a recurring "agent" like a daily brief. Manage routines with `holt routine [add | run | list | show | remove]`.

Routines live in one global file, `~/.holt/routines.json`, one entry per routine, each carrying the absolute `workspace` it runs in (captured at add time):

```json
[
  {
    "name": "brief",
    "source": { "kind": "task", "value": "summarize what changed and what is open here" },
    "when": "07:00",
    "notify": true,
    "out": "brief.md",
    "brain": "claude",
    "workspace": "/Users/you/projects/notes"
  }
]
```

- `source.kind` is `task` (an inline prompt in `value`) or `skill` (a skill name in `value`; its `SKILL.md` body is spliced into the prompt at run time).
- `when` is a 24h daily `HH:MM`. Present only for scheduled routines; absent means manual, run-on-demand.
- `notify` pushes the result to Telegram (guarded cleanly when Telegram is not configured); `out` also writes it to that file (relative to `workspace`). With neither, the result prints to stdout.
- `brain` is an optional brain id override.

A routine with a `when` also owns an entry in `~/.holt/schedules.json` (the same store `holt schedule` uses), keyed by the routine name, whose installed OS timer (launchd on macOS, cron on Linux) fires `holt routine run <name> --quiet`. The two stores are kept consistent: removing the routine removes its schedule entry and OS timer. Running a routine is trust-gated like every command that runs a task in a folder; under a non-TTY (a scheduled run) it behaves like `holt run` and refuses cleanly in an untrusted folder rather than prompting.

`holt routine add <name> --template <t>` scaffolds a routine from a small built-in map (`daily-brief`, `standup`), each a sensible task + daily schedule + notify default you can then edit.

## Machine check: `holt doctor`

`holt doctor` inspects this machine and recommends how best to run Holt on it. It is read-only: it writes no files, needs no trust, reads no keys, and always exits `0` even when a probe fails (any field it cannot read prints `unknown`).

It reports six sections: **Machine** (platform, CPU, RAM, Node), **Brains** (which of `claude`/`codex`/`gemini` are installed, plus any API brains configured in this folder's `config.json`), **Semantic memory** (whether a local Ollama with the embed model is reachable), **Knowledge wiki maintainer** (`brain` versus a RAM-sized local model), **Always-on / Telegram** (whether a bot config exists at `~/.holt/telegram.json`), and **Recommended next steps** (a checklist built from the gaps found).

The RAM-to-model mapping is defined once in `src/specs.ts` as `LOCAL_MODEL_RECS` and read via `recommendLocalModel(totalRamGB)`:

| RAM      | Local wiki model            | Footprint  | Guidance                                                        |
|----------|-----------------------------|------------|----------------------------------------------------------------|
| < 16 GB  | `llama3.2:3b` (discouraged) | ~2GB       | Local is modest; prefer the hosted `brain` maintainer.         |
| 16 GB    | `qwen2.5:7b` (or `llama3.1:8b`) | ~4.7GB  | Works but tight; prefer your always-on machine.                |
| 24-32 GB | `qwen2.5:14b`               | ~9GB       | Fits well, a solid local maintainer.                           |
| >= 48 GB | `qwen2.5:32b`               | ~20GB      | Best local quality.                                            |

The wiki maintainer feature reads this same table, so tune models in `src/specs.ts` only. The Ollama base URL and embed model name it probes honor `HOLT_OLLAMA_URL` and `HOLT_EMBED_MODEL` (see below).

## Memory files: `<folder>/.holt/memory/turns.jsonl`

Per-folder conversation memory, append-only, one JSON object per line:

```json
{"id":"a1b2c3d4","ts":1719878400000,"session":"9f8e7d6c","role":"user","content":"my landlord is called Pieter","emb":[0.0123,-0.0456]}
```

- `emb` is present only when a local Ollama embedded the turn; otherwise the turn is text-only and recalled by keyword.
- `role` is `user`, `assistant`, or `fact`. A `fact` row is a distilled memory: it is embedded and recalled like any turn, and ranks slightly higher when it matches.
- Inspect with `holt memory`, search with `holt memory search <query>`, backfill vectors with `holt memory embed`, wipe with `holt memory clear`.

Distilled facts also live in a human-editable companion file, `<folder>/.holt/memory/facts.md`, one dated `##` heading with `- ` bullets. It is written alongside the `fact` rows when a session ends, and is safe to edit by hand. View it with `holt memory facts`. Disable distillation with the `memory.extractFacts` config flag.

## Optional global memory: `~/.holt/global/turns.jsonl` + `~/.holt/memory-scopes.json`

Per-folder isolation is the **default**: recall never crosses folders. A folder can opt into an AIOS-style shared store where high-value facts are pooled and tagged by the folder they came from. This is controlled entirely outside the per-folder `config.json` (which is left unchanged), by two global files:

- **Registry: `~/.holt/memory-scopes.json`**, shape `{ "enabled": ["<abs folder path>", ...] }`. A folder listed here both **contributes** its distilled facts to the shared store and **reads** the shared store during recall. This one list is the source of truth for which folders participate.
- **Store: `~/.holt/global/turns.jsonl`**, append-only, one JSON object per line. Each row is a memory `fact` row plus a `workspace` field:

  ```json
  {"id":"a1b2c3d4","ts":1719878400000,"session":"seed","role":"fact","content":"A uses Postgres","workspace":"/Users/you/projects/a","emb":[0.01,-0.04]}
  ```

Only distilled `fact` rows are promoted (this includes wiki page rows); raw user/assistant turns are never mirrored. Rows are deduped by normalized content plus workspace, so re-saves and re-syncs never pile up. Embeddings carry over from the local row, so global recall stays semantic when Ollama is available.

Manage it with `holt memory global`:

- `holt memory global on`: add this folder to the registry, backfill its existing facts into the store, and mirror new ones automatically.
- `holt memory global off`: remove this folder from the registry (stops contributing and reading). Add `--purge` to also delete this folder's rows from the store; without it, they are left in place.
- `holt memory global status` (or bare `holt memory global`): whether this folder is enabled, how many folders contribute, and store stats.

During recall in an enabled folder, the shared store is scored with the same embedding/keyword logic and fact boost and merged with local results; the folder's own rows are excluded from the global read to avoid double counting, and each global hit is tagged with its source folder. A missing or corrupt store degrades silently to local-only recall. Delete `~/.holt/global/` and `~/.holt/memory-scopes.json` to reset global memory entirely.

## Wiki files: `<folder>/.holt/wiki/`

The derived knowledge wiki (`holt wiki`). One flat folder of Obsidian-compatible Markdown:

- `<page-slug>.md`: one synthesized page. Small frontmatter (`title`, `updated`, `sources`) then prose and a `## Related` section of `[[links]]`. `sources` is the provenance: the fact ids the page was built from, so `holt wiki rebuild` can regenerate everything from `facts.md` + `turns.jsonl`. Pages are derived, never authoritative; a rebuild overwrites hand-edits, so keep the folder under git if you edit by hand.
- `index.md`: the table of contents, listing every page as a `[[link]]` (the MEMORY.md analog).
- `.state.json`: the last-sync marker (`lastSyncTs`), so `holt wiki sync` only folds facts added since the previous sync.

Open the folder in Obsidian as a vault to browse the `[[links]]` natively, or `holt wiki open`. Wiki pages are also embedded into the recall index (as `fact`-role rows under a `wiki` session), so `holt memory search` and chat recall surface synthesized knowledge. `holt memory` counts these in its `facts` total; a `holt wiki rebuild` refreshes them cleanly.

## Graph output: `<folder>/.holt/graph.html` and `GRAPH_REPORT.md`

`holt graph` writes one self-contained HTML file to `<folder>/.holt/graph.html` (override with `--out <path>`) and opens it. By default it draws only this folder's memory, plus the wiki when one exists (`--wiki` / `--no-wiki` force it). Nothing about the default behavior changed with the richer-graph feature; code and docs are strictly opt-in.

**Richer graph (code, docs, communities).** These flags ingest the folder's own files:

| Flag / form          | Effect                                                                 |
|----------------------|-----------------------------------------------------------------------|
| `holt graph --code`  | Add a node per source file plus resolvable dependency (import) edges.  |
| `holt graph --docs`  | Add a node per doc (`.md` / `.mdx` / `.txt` / `.rst`) plus link edges. |
| `holt graph --all`   | Both of the above.                                                     |
| `holt graph report`  | Ingest code + docs, detect communities, write `GRAPH_REPORT.md`.       |

- **Ingest scope + skips.** The walk skips `node_modules`, `.git`, `.holt`, `dist`, `build`, `.next`, `coverage`, other build/vendor dirs, and any dotfolder. Safety caps: at most 2000 files, 400KB per file, 64MB total. Skips are logged (`ingest skipped: ...`). Code extensions include `js`, `ts`, `jsx`, `tsx`, `mjs`, `cjs`, `py`, `go`, `rb`, `rs`, `java`, and more.
- **Dependency edges** are best-effort per language. JS/TS: `import ... from`, `export ... from`, `require()`, dynamic `import()`; only relative specifiers (`./`, `../`) resolve to local files (trying common extensions + `index.*`), bare/package imports are dropped. Python: `import x` and `from x import ...` mapped to local module files where resolvable. Docs: Markdown links and `[[wikilinks]]` between docs in the set. Unresolved references are dropped, never fatal.
- **Communities.** Once code/docs are ingested, Holt runs **label propagation** (deterministic, zero dependency) over the whole graph, stamps each node with a community id, and tints node rings by community in the HTML.
- **`GRAPH_REPORT.md`** (from `holt graph report`, `--out` to relocate) lists node / edge / community counts, the highest-degree **god nodes** with their community, and a per-community summary (size + representative files). Safe on empty input (it says there is nothing to ingest, no crash).

The HTML stays self-contained, valid, and XSS-safe: file paths and code snippets are embedded as escaped JSON and rendered via `textContent`, so a file whose name or contents contain `</script>`, `<!--`, or `<img onerror=...>` cannot break out of the data block or inject.

## Launch alias in your shell rc

If you set a launch word during `holt init` or `holt setting`, Holt writes a fenced block into your shell rc (`.zshrc`, `.bashrc`, or `.profile`, chosen from `$SHELL`):

```bash
# >>> holt launch alias >>>
alias ai="holt chat"
# <<< holt launch alias <<<
```

The block is idempotent, re-running replaces it. Reset the launch word to `holt` in `holt setting` to remove the block, or delete the block by hand.

## Environment variables

| Variable          | Default                   | Effect                                                                 |
|-------------------|---------------------------|-----------------------------------------------------------------------|
| `HOLT_OLLAMA_URL` | `http://127.0.0.1:11434`  | Base URL of the local Ollama used for embeddings and the `local` wiki maintainer. |
| `HOLT_EMBED_MODEL`| `nomic-embed-text`        | Embed model name Holt looks for and uses.                             |
| `HOLT_REGISTRY_URL`| `https://raw.githubusercontent.com/holt-os/registry/main/registry.json` | Skill registry index used by `holt skill search` and install-by-name. A URL, a `file://` URL, or a plain path. |
| `NO_COLOR`        | unset                     | If set (to anything), disables ANSI colors. Color is also off when output is not a TTY. |

## Skill registry: `~/.holt/registry-cache.json`

`holt skill search <query>` and `holt skill add <name>` read a **git-based registry**: a JSON index in a git repo, no server involved. Format:

```json
{
  "version": 1,
  "skills": [
    { "name": "hello-registry", "description": "A tiny demo skill.", "source": "https://github.com/you/hello-registry.git", "author": "you", "tags": ["demo"] }
  ]
}
```

`source` is anything `holt skill add` accepts (a git URL, optionally with the `SKILL.md` in one subfolder, or a local path). It may also carry a `#<subdir>` suffix (split on the first `#`) that points at one skill folder inside the repo, e.g. `https://github.com/holt-os/registry#skills/pm-prd`. That lets one repo hold many skills, so the community registry can be a single monorepo. The subdir is validated to stay inside the source (absolute paths or `..` traversal are refused). Per entry, `name` and `source` are required; `description`, `author`, and `tags` are optional. Malformed rows are skipped so one bad entry never breaks the index.

- **Location:** `HOLT_REGISTRY_URL` if set, otherwise the community index `https://raw.githubusercontent.com/holt-os/registry/main/registry.json`. The override may be a URL, a `file://` URL, or a plain filesystem path, so the registry is usable (and testable) with no network at all.
- **Cache:** the fetched index is cached at `~/.holt/registry-cache.json` (keyed by URL) with a one-hour TTL. Within the TTL, search reuses the cache instead of re-fetching. `--refresh` forces a re-fetch; a stale cache for the same URL is used as an offline fallback if a live fetch fails. A corrupt cache is ignored, never fatal.
- **Search:** `holt skill search <query>` filters by name, description, and tags (case-insensitive substring, name matches ranked first). An empty query lists all entries.
- **Install by name:** `holt skill add <name>` resolves the name to its `source` and installs through the same path as a direct URL/path add. URLs and existing paths still install directly.
- **Publish (zero-infra):** `holt skill publish [<name>]` validates the skill's `SKILL.md` and prints the JSON entry plus instructions to open a PR against `https://github.com/holt-os/registry`. Nothing is pushed; you add the entry by pull request. If the registry is unreachable, search and install-by-name fail cleanly with a clear message rather than crashing.

## Resetting

- **One folder:** delete `<folder>/.holt/` to drop that folder's config and memory. `holt init` will set it up fresh.
- **Just the memory:** `holt memory clear` (asks first) wipes `turns.jsonl` but keeps config.
- **Trust:** delete `~/.holt/trust.json`, or remove a single path from it, to make Holt ask about a folder again.
