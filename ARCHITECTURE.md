# Architecture

Holt v0.4 is a small, dependency-free TypeScript CLI. It shells out to agent CLIs you already have installed (Claude Code, Codex, Gemini), keeps a per-folder memory it can recall from, and owns the transcript so you can switch models mid-conversation without losing context.

The whole thing runs on Node, has no runtime dependencies, and stores everything as plain files you can read.

## The shape of it

```
                          holt <command>            (src/cli.ts)
                                 |
        +------------------------+------------------------+
        |            |           |          |             |
      init          chat       memory     setting       login
   (install +   (the REPL)   (inspect/   (brains +    (hand off to a
    sign-in)                  wipe)       alias)       brain's own login)
        |            |
        |            |  every command first calls ensureTrusted()
        |            |         -> ~/.holt/trust.json
        |            |
        |            v
        |     +--------------------------------------------------+
        |     |  chat loop (src/commands/chat.ts)                |
        |     |                                                  |
        |     |  1. recall(message)  ---------> memory.ts        |
        |     |  2. renderPrompt(history, msg, recalled)         |
        |     |         = recall notes + last 12 turns + message |
        |     |  3. runBrain(brain, prompt, onChunk) --> spawn   |
        |     |  4. stream stdout to the terminal                |
        |     |  5. appendTurn(user), appendTurn(assistant)      |
        |     +--------------------------------------------------+
        |            |                          |
        |            v                          v
        |     brain adapter (brains.ts)   memory (memory.ts)
        |     spawn claude/codex/gemini   <cwd>/.holt/memory/turns.jsonl
        |     non-interactive, one turn   embed via local Ollama (optional)
        |                                 recall: cosine or keyword overlap
        |
        v
  installs + logins (install.ts): spawn with the terminal attached
  launch alias (alias.ts): writes an `alias` block into your shell rc
```

## Command dispatch

`src/cli.ts` is the entry point. It reads `process.argv[2]`, matches it in a `switch`, and calls the matching handler in `src/commands/`. That is the whole router. The commands are `init`, `chat`, `memory`, `setting` (also `settings`), `login`, plus `version` and `help` handled inline. Unknown commands print a hint and set a non-zero exit code.

Every command that touches a folder calls `ensureTrusted()` before doing anything else.

## Per-folder trust

Holt runs in the folder you launch it from, like a per-project tool. Before it reads or writes anything, it checks whether that folder is trusted.

- Trusted folders live in a single global file: `~/.holt/trust.json`, shape `{ "trusted": [ "/abs/path", ... ] }`.
- `isTrusted()` checks membership; `trustDir()` appends the absolute path.
- `ensureTrusted(ask)` (in `src/workspace.ts`) prompts `Trust and continue? [y/N]` on first use and remembers your answer. Decline and the command exits without writing anything.

This is a deliberate blast-radius limit: a brain can only act in folders you have explicitly trusted.

## Workspace data layout

Trust is global. Everything else is scoped to the folder:

```
~/.holt/
  trust.json                  list of trusted absolute paths

<your-folder>/.holt/
  config.json                 brains, default brain, config version
  memory/
    turns.jsonl               append-only conversation memory
```

Path helpers live in `src/workspace.ts`: `workspace()` is just `process.cwd()`, `wsHoltDir()` is `<cwd>/.holt`, `wsConfigPath()` is `<cwd>/.holt/config.json`. Memory paths are in `src/memory.ts`.

## CLI-brain adapters

A "brain" is an agent CLI installed on your machine. Holt does not talk to model APIs directly and never handles your keys; it drives the tool you already logged into.

The adapter is `src/brains.ts`. Each brain has a `command` and a fixed set of non-interactive `args` (from `BRAIN_DEFS` in `src/config.ts`):

| Brain  | command  | args      |
|--------|----------|-----------|
| claude | `claude` | `-p`      |
| codex  | `codex`  | `exec`    |
| gemini | `gemini` | `-p`      |

`runBrain()` builds the argv as `[...args, prompt]` and `spawn()`s the process once per turn with `stdio: ['ignore', 'pipe', 'pipe']`. It is a single non-interactive invocation, not a long-lived session. stdout is read as it arrives and forwarded through an `onChunk` callback so the reply streams into the terminal live; the full text is collected and returned when the process closes. A non-zero exit (or empty output) is surfaced as an error, using stderr when present.

`isInstalled()` uses `which` (or `where` on Windows) to check whether a brain's command is on `PATH`.

### Why brain switching keeps context

Holt owns the transcript. The brain does not; each `runBrain()` call is stateless from the CLI's point of view. On every turn, `renderPrompt()` (in `src/brains.ts`) folds the whole context into one prompt string:

1. A short instruction to continue the conversation and reply only as the assistant.
2. A block of relevant notes recalled from past sessions.
3. The recent transcript, capped at the last `MAX_REPLAY_TURNS` (12) turns.
4. The new user message, ending with `Assistant:`.

Because the context is reconstructed and passed in full on every call, switching brains with `/brain gemini` mid-conversation just means the next prompt goes to a different command. The new brain receives the same rendered context and picks up where the last one left off. The `/brain` handler only changes which config entry is used; it never clears `history`.

## Memory pipeline

Memory is per folder, append-only, and stored as JSONL at `<cwd>/.holt/memory/turns.jsonl`. One line per turn: `{ id, ts, session, role, content, emb? }`. Everything is in `src/memory.ts`.

**Append.** After each successful exchange, the chat loop writes two turns (user, then assistant) with `appendTurn()`. If embeddings are available, each turn is embedded and the vector is stored inline on the same line.

**Embed (optional, local).** If a local [Ollama](https://ollama.com) is reachable and has the embed model, `embed()` calls its `/api/embeddings` endpoint and stores the vector. Vectors are rounded to four decimals to keep the JSONL small. No keys, nothing leaves the machine. `embeddingsAvailable()` probes `/api/tags` once per process and caches the result. If Ollama is not running, embedding is skipped and turns are stored as text only. `holt memory embed` backfills vectors onto older text-only turns in one pass.

**Recall.** On each message, `recall(query, currentSession, k)` scores past turns (never the current session) and returns the top matches:

- **Semantic:** if the query embeds and a turn has a vector, score is cosine similarity, kept above a 0.35 threshold.
- **Keyword fallback:** otherwise, score is the fraction of query words (length > 2) that appear in the turn, kept above 0.15.

The mode is chosen per turn automatically: semantic where a vector exists, keyword where it does not. Results are sorted by score and capped at `k` (4 during chat, 5 for the `/memory <query>` preview, 8 for `holt memory search`).

**Why recall instead of unbounded replay.** Long conversations stay cheap. Only the last 12 turns are replayed verbatim; older context does not pile up in the prompt. Instead it comes back on demand through recall, so a chat started weeks ago still surfaces the one relevant thing you said without resending the entire history every turn.

**Facts pipeline.** When a chat session ends (and after at least three exchanges), `extractAndSaveFacts()` in `src/facts.ts` makes one silent call to the active brain asking it to distill 1 to 5 durable facts as a JSON array. `parseFacts()` reads the reply tolerantly, then each new fact goes through `saveFact()` in `src/memory.ts`, which writes it two ways: a human-readable bullet under a dated heading in `<cwd>/.holt/memory/facts.md` (safe to hand-edit), and an embedded recall row in `turns.jsonl` with `role: 'fact'`. Duplicates (normalized exact match against existing fact rows and facts.md lines) are skipped. During recall, a fact that already clears its threshold gets a small score boost (1.15x) so distilled memory ranks slightly ahead of raw turns. The whole step is best-effort: it never blocks exit and swallows any error. Turn it off with the `memory.extractFacts` config flag. Inspect facts with `holt memory facts`.

## Launch alias

`holt init` and `holt setting` can install a short launch word (like `ai`) that runs `holt chat`. `src/alias.ts` writes a fenced block into your shell rc:

```
# >>> holt launch alias >>>
alias ai="holt chat"
# <<< holt launch alias <<<
```

It picks the rc file from `$SHELL` (`.zshrc`, `.bashrc`, or `.profile`), and the block is idempotent: re-running replaces the existing block rather than stacking duplicates. `removeAlias()` strips it, `currentAlias()` reads back the configured word.

## Terminal I/O

`src/ui.ts` holds a tiny color helper (disabled when output is not a TTY or when `NO_COLOR` is set) and `createReader()`, a single queued stdin reader that hands out lines one `ask()` at a time. The queue avoids a readline race that would otherwise drop piped input, which is what makes scripted testing of the REPL possible. `src/install.ts` runs installs and logins with `stdio: 'inherit'` so the child tool owns the terminal during sign-in.

## Where it is heading

None of the following is built yet. This is the roadmap, kept here so the direction is legible; do not read it as a description of current behavior.

- **Direct API brains.** Talk to model providers directly as an alternative to driving an installed CLI, for people who would rather paste a key than install a tool.
- **Skills.** Install, search, and publish skills in the [agentskills.io](https://agentskills.io) format, so behavior is portable in and out of Holt.
- **Knowledge graph view.** A way to see and walk your own memory as a graph, not just recall from it.
- **Local-executes / cloud-reviews orchestration.** A local model does the work; a cloud model reviews only the risky or irreversible steps before they run.
- **Channels.** Reach Holt from somewhere other than the terminal (for example Telegram).
- **MCP plugin boundary.** A stable plugin surface, likely over the Model Context Protocol, so providers, channels, and tools can be added without touching the core.
