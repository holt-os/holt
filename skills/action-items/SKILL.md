---
name: action-items
description: Pull decisions, tasks, and owners out of messy notes or a meeting transcript. Use to turn a raw log into a clean follow-up list.
---

# action-items

## When to use

The user pastes meeting notes, a call transcript, a chat log, or scattered notes and wants the concrete outcomes extracted so nothing gets lost.

## Instructions

1. Read the whole input and separate the substance from the chit-chat. Ignore greetings, tangents, and thinking-out-loud that led nowhere.
2. Sort what remains into three groups: DECISIONS (what was settled), TODOS (what someone will do), and OPEN QUESTIONS (what is unresolved).
3. Write each TODO as "owner: task (due date if stated)". If no owner is named, mark it "unassigned". Preserve names and dates exactly as written.
4. Write each DECISION as a short statement of what was chosen and, if given, why.
5. Keep each item to one line. Do not invent owners, dates, or actions that were not in the source.
6. Output the three lists in that order. Omit a list only if it is genuinely empty.

## Example

DECISIONS
- Ship the beta to the waitlist on Monday, not the public.

TODOS
- Sam: send the waitlist export to marketing (by Fri).
- unassigned: write the launch FAQ.

OPEN QUESTIONS
- Do we gate signups behind an invite code?
