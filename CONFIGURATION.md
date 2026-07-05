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
  - `autoSync` (boolean, optional): reserved for a future sync-on-session-end hook; off by default.

To point a brain at a different CLI or add flags, edit `command` / `args`. See the echo-brain trick in `CONTRIBUTING.md` for a testing use of this.

## Stored API keys: `~/.holt/credentials.json`

Written only when you paste a raw key while connecting an API brain. One optional key per provider (`anthropic`, `openai`, `gemini`), file mode `600`. Prefer env vars if you rotate keys often; delete the file to forget every stored key.

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
| `NO_COLOR`        | unset                     | If set (to anything), disables ANSI colors. Color is also off when output is not a TTY. |

## Resetting

- **One folder:** delete `<folder>/.holt/` to drop that folder's config and memory. `holt init` will set it up fresh.
- **Just the memory:** `holt memory clear` (asks first) wipes `turns.jsonl` but keeps config.
- **Trust:** delete `~/.holt/trust.json`, or remove a single path from it, to make Holt ask about a folder again.
