# Porting skills to other agents

Holt skills are plain `SKILL.md` folders, so the skill text is the same for
every agent. What differs per agent is the thin layer that gets the skill list
in front of the model at the start of a session and lets it load a skill on
demand. This page explains the three ways an agent can be wired up, what each
one needs, and how Holt does it today for Claude Code, Codex, and Gemini CLI.
Use it when you want to support a new agent as a Holt brain, or when you want
to carry Holt skills into an agent Holt does not drive yet.

## The one rule

A skill that nobody tells the model about is inert. The integration is not the
skills; it is the session-start injection: some text, delivered automatically
on every session with no manual step, that says which skills exist and how to
load one. If an agent only works when the user pastes a prompt or flips a mode
each session, it cannot be supported properly.

Two corollaries:

1. Skills name actions ("read the file", "run the tests", "start a subagent"),
   never one product's tool names. Do not edit skill bodies to fit an agent.
   The registry enforces the prompt-only format; see `CONTRIBUTING.md` in the
   registry repo.
2. Ship through the agent's own install surface. Do not hand-edit a user's
   global config to inject something. Holt follows this: it writes a context
   file only when none exists or when it created it (the `CONTEXT_MARKER` check
   in `src/commands/launch.ts`), and it never clobbers a file you authored.

## The three integration shapes

### Shape A: shell hook

The agent can run a shell command at a lifecycle event and add its stdout to
the model's context. Check that the specific event exists and can inject
context; a hook system that only fires around tool calls is not enough.

Holt today: `holt hook` in `src/commands/hook.ts` installs a Claude Code
`UserPromptSubmit` hook whose stdout becomes extra context (recalled memory),
and a `Stop` hook that captures facts. It is Claude Code only. The hook bodies
must never throw and must keep stdout clean, because stdout is injected
verbatim.

### Shape B: in-process plugin or extension

The agent loads a module with lifecycle callbacks, and your code can mutate the
message list or register tools. Holt has no in-process plugin today. The closest
equivalent is the MCP server in `src/mcp/server.ts`, which exposes
`list_skills` and `get_skill` (defined in `src/mcp/tools.ts`) to any
MCP-capable agent. Note the difference: MCP lets the model pull skills when it
decides to, it does not push the list at session start.

### Shape C: instructions file

The agent has no hook and no plugin API, but always loads a context file from
the project or from an extension you install. You cannot run code; the file
carries the bootstrap text itself. If the agent has no include syntax, inline
the text. Do not assume an include is expanded: test it with a unique marker
and confirm the marker reaches the model without a file-read tool call.

Holt today: for Codex and Gemini, `brandContextFile` in
`src/commands/launch.ts` writes a managed `AGENTS.md` or `GEMINI.md` into the
project. The Gemini extension in `gemini-extension.json` also declares
`contextFileName` pointing at the extension's own `GEMINI.md`, which documents
the memory and skill tools.

## How Holt runs brains and skills today

- Interactive launch (`holt`, `holt launch`): the real agent CLI starts with its
  own TUI. `INTERACTIVE_ARGS` and `brandingFlags` in `src/commands/launch.ts`
  map each brain to its invocation. Claude gets an appended system prompt
  (`HOLT_IDENTITY`); Codex and Gemini get the managed context file above.
- Skills inside that session: `src/skillcompiler.ts` compiles every enabled
  skill into the brain's native command format. Claude gets the skill folder
  copied verbatim into `.claude/skills/<name>/`. Gemini gets a generated
  `.gemini/commands/<name>.toml`. Codex gets a prompt file under its global
  prompts directory. Everything written is tracked in `.holt/skill-commands.json`
  so removal only touches Holt's own files.
- Holt's own REPL and runner (`src/commands/chat.ts`, `src/runner.ts`): the
  brain is run once per turn in non-interactive mode, and `skillsPromptBlock()`
  in `src/skills.ts` appends the list of installed skills to the prompt every
  turn. `/skill <name>` swaps in the skill body via `resolveSkillInvocation`.
  This is the only fully automatic, every-turn skill bootstrap Holt has, and it
  works for API brains too.
- Install: `holt skill add <name>` resolves a registry name, or accepts a git
  URL, `git-url#subdir`, or a path (`src/registry.ts`, `src/commands/skill.ts`).
  The registry index location is `HOLT_REGISTRY_URL` or the community default.

## Capability checklist

Before adding an agent as a brain, confirm it can do each of these.

| Capability | Why | If absent |
|---|---|---|
| Automatic session-start injection (hook, plugin, or context file) | Without it skills are never offered | Hard stop for native support; fall back to Holt's REPL path, which injects the skill list every turn |
| Load a skill's full text on demand | The model must read the body when a skill applies | Fallback: read the `SKILL.md` file directly |
| File read, write, edit | Most skills touch files | Essential |
| Run shell commands | Verification and test skills depend on it | Essential for those skills |
| Subagents | `writing-skills` pressure testing, parallel work | Skills should say to do the work inline and note the weaker test |
| Non-interactive one-shot mode | Holt's REPL and routines call the brain headless | The agent can still launch interactively, but not run routines |

## Routing table

| If the agent... | Use | Holt reference |
|---|---|---|
| runs a command at prompt or session start and reads stdout | Shape A | `src/commands/hook.ts` |
| speaks MCP | Shape B via MCP, pull-style | `src/mcp/server.ts`, `src/mcp/tools.ts` |
| loads an always-on instructions file | Shape C | `brandContextFile` in `src/commands/launch.ts`, `GEMINI.md` |
| has a native custom command format | compile the skill to it | `src/skillcompiler.ts` |
| has none of the above | run it headless and prepend the skill block each turn | `src/runner.ts`, `skillsPromptBlock()` |

## Verify the port

1. Marker test: put a unique nonsense token in the bootstrap text, start a fresh
   session, and ask the model to repeat it. Do this for every injection path.
2. Ask the model to list the skills it can see. The names should match
   `holt skill list`.
3. Run one skill end to end and check it followed the instructions, not just
   that it printed a plausible answer.

## Install the engineering skills

The four skills adapted from superpowers live in the community registry:

    holt skill add verification-before-completion
    holt skill add systematic-debugging
    holt skill add receiving-code-review
    holt skill add writing-skills

Add `--global` to make them available in every folder.

Adapted from obra/superpowers docs/porting-to-a-new-harness.md (MIT, Copyright (c) 2025 Jesse Vincent).
