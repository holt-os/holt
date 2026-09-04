---
name: level-up
description: A weekly working session that turns one piece of recurring manual work into something Holt does for you, and ships it before the session ends. Use as a standing ritual once memory has real facts in it.
---

# level-up

## When to use

The user has been using Holt and wants it to carry more. This is the ritual that
compounds: once a week, one drain becomes one shipped capability. Run it after
memory holds real facts about their work; on an empty folder, run `onboard`
first.

The session fails if it ends in a plan. It succeeds if something exists that did
not exist an hour ago.

## Instructions

### 1. Find the constraint

Read what memory already knows. Relevant past notes are injected above; also run
`holt memory facts` and search for the work they complain about:

```
holt memory search <what they keep doing by hand>
```

Then ask what ate their time this week, and what they did more than once. Pick
**one**. The best candidate is frequent, rule-shaped, and low-stakes if it comes
out slightly wrong. Say plainly why you picked it over the others.

If several are tempting, choose the boring one. A dull thing that runs every
week beats an ambitious thing that runs once.

### 2. Decide what to do with it

Three options, in this order:

- **Drop it.** Does this task need to exist? Work that only continues out of
  habit should be stopped, not automated. Ask this first and mean it; the
  cheapest automation is the one you do not build.
- **Automate it.** Rule-shaped and repeatable, with a checkable output.
- **Hand it off.** It needs judgement, relationships, or accountability a
  machine should not hold. Say so and move to the next candidate.

Automating something that should have been dropped makes the waste permanent
and harder to see. Push back before building.

### 3. Map it before building

Walk the task through in the user's own words: what starts it, what information
it needs, what it produces, and who sees the output. Write the steps down. If
you cannot state the steps in plain sentences, it is not ready to build.

Then set how much rope it gets:

- **Drafts, you send.** Anything that leaves the house: email, posts, messages.
- **Runs, you review.** Produces a file or a note you read afterwards.
- **Runs unattended.** Only for work that is reversible and already proven by
  hand for a few cycles.

Start one level more cautious than feels necessary. Moving up later is easy;
un-sending is not.

### 4. Build it now

Pick the lightest thing that works:

- A **skill**, when it is a repeatable way of thinking or writing:
  `holt skill create <name>`, then write the instructions into its `SKILL.md`.
  Check the registry first with `holt skill search <topic>`, because the work
  may be done already.
- A **routine**, when it is a task worth naming and rerunning:
  `holt routine add <name> "<task>"`, run it with `holt routine run <name>`.
- A **schedule**, when it should happen without being asked:
  `holt schedule add`, or a scheduled routine. Only after it has produced good
  output by hand at least twice.
- A **connection**, when the blocker is that Holt cannot see the material:
  `holt hook` for ambient memory in Claude Code, `holt mcp setup` for other
  tools. Sometimes the whole win is that it can finally read the thing.

Prefer a fixed sequence of steps over an open-ended agent. Predictable and
slightly dumb beats clever and unrepeatable.

### 5. Test it on something real

Run it once, now, on genuine input, and read the output with the user. If it is
wrong, fix it in this session. A capability that has never run on real data is
not shipped.

Then agree how it gets switched off: which command removes it, or which file to
delete. Anything that runs on a timer needs a way to stop.

### 6. Close the loop

1. Save what was built and why, so next week starts informed:
   ```
   holt memory add "Built the <name> routine on <date>: <what it does, what triggers it>"
   ```
2. Note what to watch for: the failure mode most likely to show up first.
3. Name the single next candidate from the list you did not pick, so the next
   session starts with a running head start.

## Example

This week: forty minutes lost to writing the same client update every Friday.

Not dropped, it is genuinely wanted. Not handed off, the facts live here.
Automate it, at drafts-you-send, because it goes to a client.

Built as a routine over the folder's memory, run once against this week's real
work. First draft named the wrong milestone; instructions tightened, second
draft was sendable. Off switch: `holt routine remove friday-update`.

Watch for: it will keep sounding confident about numbers it has not been given.

Next week's candidate: the invoice chase.
