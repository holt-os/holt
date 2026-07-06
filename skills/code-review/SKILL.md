---
name: code-review
description: Review a file or a diff for correctness bugs, edge cases, and simplifications. Use before merging or when a change feels risky.
---

# code-review

## When to use

The user shares a file, a function, or a diff and wants a focused review. The goal is catching real problems, not restyling working code.

## Instructions

1. Read for real defects first: logic errors, off-by-one and boundary mistakes, unhandled error paths, null or empty cases, security holes (injection, unescaped input, secrets), and resource leaks (unclosed files, sockets, handles).
2. Then look for clarity and simplification: duplicated logic, dead code, overly clever constructs, and places a simpler shape would do the same job.
3. Then note style issues, but only if they hurt readability. Skip pure nits unless the user asks for them.
4. Report each finding as file:line, then what is wrong, then why it matters, then a concrete fix or the corrected snippet.
5. Rank findings by severity: bugs and security first, then simplifications, then minor. Put the most important at the top.
6. Be concise. If a change is clean, say so plainly instead of manufacturing feedback.

## Example

- api.ts:42 (bug): the loop uses <= arr.length, so the last iteration reads arr[arr.length] which is undefined. Change to <.
- api.ts:88 (simplify): this if/else both return the same object with one field flipped; collapse to one return with a ternary.
