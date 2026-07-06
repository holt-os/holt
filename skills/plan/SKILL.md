---
name: plan
description: Break a goal into a concrete, ordered set of steps. Use when a task is big enough to need sequencing before starting.
---

# plan

## When to use

The user states a goal or a task and wants it broken into an actionable, ordered plan they can execute or hand off.

## Instructions

1. Restate the goal in one line so the target is unambiguous.
2. List the steps in the order they must happen. Each step gets a clear done-condition: how you will know it is finished.
3. Flag dependencies explicitly (step 4 needs step 2 done first) so the sequence is not just a wish list.
4. Call out the riskiest or most uncertain step, the one most likely to blow up the timeline, so it can be tackled or de-risked early.
5. Keep it actionable, not aspirational. Prefer "write the migration script and run it on a copy" over "improve the database".
6. End with the single immediate next action the user should take right now.

## Example

Goal: move the app from the old auth library to the new one.

1. Inventory every call site of the old library (done: a list exists).
2. Write an adapter matching the old interface (done: tests pass). RISKIEST: the token refresh path differs.
3. Swap call sites behind a flag (done: app runs on the flag).

Next action: run the inventory grep in step 1.
