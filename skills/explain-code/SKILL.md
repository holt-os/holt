---
name: explain-code
description: Walk through what a file or function does and how it fits into the wider system. Use to onboard onto unfamiliar code.
---

# explain-code

## When to use

The user shares a file or function they did not write (or wrote a while ago) and wants to understand what it does, how it works, and how it connects to the rest of the code.

## Instructions

1. Start with a one-line purpose: what this code is for, in plain terms.
2. Describe the flow and structure: the main steps or branches, in the order they run. Explain intent, not every line.
3. Call out key dependencies and side effects: what it imports or calls, what state it reads or mutates, what it writes to disk, network, or the console.
4. Flag any gotchas: assumptions it makes, inputs it does not handle, and non-obvious behavior a reader would trip on.
5. Match depth to size. A small helper gets a few sentences; a large module gets a section per responsibility. Do not restate the code line by line.
6. If something is genuinely unclear or looks buggy, say so rather than inventing a rationale.

## Example

Purpose: parses a config file and returns a typed settings object.

Flow: reads the file, tries JSON.parse, falls back to defaults on any error, then validates required keys.

Gotcha: it swallows parse errors silently, so a malformed config looks identical to a missing one.
