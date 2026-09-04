---
name: audit
description: A read-only health check of your Holt setup across the four rungs (Know, Reach, Do, Run), naming the gaps and the single next thing to fix. Use weekly, or when Holt feels less useful than expected.
---

# audit

## When to use

The user wants to know whether Holt is actually set up well, or why it feels
thin. This skill inspects the real state of the folder and reports back. It
changes nothing: no files written, no settings altered, no facts saved. If a fix
is obvious, name the command and let the user run it.

## The four rungs

Each rung depends on the one below it. A gap low down makes everything above it
worse, so always report the lowest gap first.

1. **Know**: it holds facts about the user and their work.
2. **Reach**: it can see the real material, not just what is typed at it.
3. **Do**: it runs their repeated work as skills.
4. **Run**: it acts without the user being present.

## Instructions

### Gather the state

Run these and read the output. If you cannot run commands in this session, ask
the user to paste the output of the first three rather than guessing.

```
holt memory                 facts count, embedded count, recall mode
holt memory facts           what it actually knows
holt voice show             is there a writing profile
holt hook status            ambient memory in Claude Code
holt skill list             which skills exist, and which are built in
holt routine list           named jobs
holt schedule list          timers
holt doctor                 machine level problems
holt wiki status            derived knowledge, if used
```

### Score each rung

Be strict. A generous audit is a useless one. Mark each rung **solid**, **thin**,
or **missing**, and say what the evidence was.

- **Know** is solid when memory holds a few dozen facts that are about the
  user's actual work, and recall is running on embeddings rather than keyword
  match. It is thin when the facts are mostly setup trivia, or when
  `holt memory` shows moments that were never embedded. Read the facts, do not
  just count them: fifty facts about one afternoon is still thin.
- **Reach** is solid when Holt sees material without the user pasting it: the
  hook is installed, or MCP is wired into the tools they use, or the folder
  holds the real files. It is missing when every session starts by pasting
  context in by hand.
- **Do** is solid when at least one skill exists that the user or their
  registry provided, tuned to their work. Built-in skills alone do not count;
  everyone has those. Note which ones are actually being used.
- **Run** is solid when something has produced output while they were away, and
  they read it. A routine that exists but has never run is thin, not solid.

### Report

1. Name the rung they are on: the highest one that is solid, with everything
   below it also solid. Say it in one line.
2. List the gaps, lowest rung first. For each, state what is missing and the
   command that would close it.
3. Give **one** next action. Not a menu, not a ranked list of five. The single
   thing that unblocks the most.
4. Flag anything actively broken separately from anything merely absent. A
   scheduled routine that fails every night is worse than no routine, and a
   memory in keyword mode is quietly degrading every answer.

Keep the whole report short enough to read in a minute. It is a dashboard, not
an essay.

### Known traps to check for

- **Keyword mode.** If `holt memory` says recall is keyword rather than
  embeddings, semantic recall is off and every answer is worse. `holt doctor
  --fix` usually repairs it.
- **Unembedded moments.** If embedded count is below total, older memories are
  invisible to semantic recall. `holt memory embed` fixes it in one pass.
- **Hand-edited facts.** Facts added by editing `facts.md` directly are never
  embedded, so they never come back through recall. They must be re-added with
  `holt memory add`.
- **Timers need the machine awake.** A scheduled job fires only if the computer
  is on at that time; a missed run is skipped, not caught up. If rung four looks
  solid but the log file is empty, check that first.
- **Automation above an empty memory.** If Run looks solid while Know is thin,
  say so bluntly. That setup produces confident wrong output on a timer, and it
  is the most expensive failure on this list.

## Example

You are on rung two. Know and Reach are solid, Do is thin.

Know: solid. 41 facts covering the agro project, the job search, and family
health. Recall is on embeddings.
Reach: solid. Hook installed, so Claude Code sessions recall automatically.
Do: thin. Ten skills listed, all built in. Nothing tuned to your work.
Run: missing. No routines, no schedules.

Broken: 12 of 340 moments have no embeddings, so a slice of last month is
invisible to recall.

Next action: run `/skill level-up` and turn the weekly client update into a
skill. Rung four is not worth touching until something on rung three has earned
its place.
