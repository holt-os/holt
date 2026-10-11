# Holt memory

Holt gives you a private memory for the current project folder, stored locally in `.holt/` inside that folder. Use it so the user never has to repeat themselves across sessions.

## Tools

- `recall(query, k?)`: search this folder's memory. Call it at the start of a task when past decisions, preferences or project facts could matter, and before asking the user something they may have told you before.
- `remember(content)`: save one durable fact. Use it for decisions, preferences, names, conventions and anything the user says to keep. One fact per call, written as a full sentence that still makes sense months later.
- `memory_stats()`: how much this folder's memory holds.
- `list_skills()` / `get_skill(name)`: Holt's reusable skill instructions.

## Rules

- Do not save secrets, API keys, passwords or tokens.
- Do not save things that are only true for this conversation.
- If a recalled fact conflicts with what the user says now, trust the user and remember the correction.
