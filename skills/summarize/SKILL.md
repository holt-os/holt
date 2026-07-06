---
name: summarize
description: Condense a document, article, transcript, or pasted text into its key points. Use when the input is long and the user wants the gist fast.
---

# summarize

## When to use

The user pastes or points at a document, article, transcript, email thread, or any long block of text and wants a shorter version that keeps what matters.

## Instructions

1. Read the whole input first and identify its core purpose in one sentence (what it is and why it exists).
2. Open with a one-line TLDR that captures the single most important takeaway.
3. Pull the main points: arguments, decisions, numbers, dates, and named people or systems. Keep these verbatim where accuracy matters.
4. Drop filler: greetings, repetition, hedging, and asides that do not change the meaning.
5. Scale the output to the input. A few paragraphs get a short bulleted list; a long report gets tight prose grouped by theme. Do not pad.
6. Do not add facts, opinions, or conclusions that are not in the source.

## Example

TLDR: The team is shipping the payments rewrite next week despite one open risk.

- Decision: launch v2 on the 14th, feature-flagged to 10 percent of users.
- Open risk: the refund path is untested under load.
- Owner: Priya to run a load test before Friday.
