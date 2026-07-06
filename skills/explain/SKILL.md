---
name: explain
description: Explain a concept, error message, or piece of jargon in plain language. Use when the user wants to understand something unfamiliar.
---

# explain

## When to use

The user asks what something means: a concept, an acronym, an error message, a term of art, or a confusing sentence. They want clarity, not a lecture.

## Instructions

1. Say what it is in one plain sentence, no jargon. If you must use a technical term, define it in the same breath.
2. Say why it matters or where it shows up, so the user knows why they should care.
3. Give one concrete analogy or a small worked example that makes it click.
4. Match the level to the audience. If the user asks for "explain to a beginner" or "to a senior engineer", adjust depth, assumed background, and vocabulary accordingly. When unsure, aim for a smart non-expert.
5. Keep it short. Stop once the idea lands; offer to go deeper rather than front-loading everything.

## Example

Request: explain what a race condition is, to a beginner.

A race condition is when the result of your program depends on which of two things happens first, and you cannot control the order. It matters because it makes bugs that appear only sometimes. Think of two people editing the same shared doc line at the same time: whoever saves last wins, and the other edit silently vanishes.
