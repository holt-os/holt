# Architecture

Holt is a small, strongly-typed **TypeScript core** surrounded by an **MCP plugin pantry**. The core knows nothing about any plugin's language — providers, embeddings, skills, channels, and tools all speak the [Model Context Protocol](https://modelcontextprotocol.io).

```
   you ──(CLI)────────▶┌─────────────────────────────────────┐
   you ──(Telegram)───▶│           HOLT CORE (TypeScript)     │
                       │  agent loop · brain router           │
                       │  memory orchestration                │
                       │  risky-action review gate            │
                       │  MCP plugin dispatcher               │
                       └──────────────────┬──────────────────┘
                                          │  MCP (stdio / http)
      ┌───────────┬───────────┬───────────┼───────────┬───────────┐
      ▼           ▼           ▼           ▼           ▼           ▼
  providers   embeddings   channels     skills     graph       tools
  (any LLM)   local/cloud  telegram…  agentskills  (memory)   (files…)
```

## Principles

- **Small core, everything else is a plugin.** No plugin is privileged. The core boots Node-only; other runtimes (e.g. Python for a plugin) are installed on demand.
- **Provider-agnostic brain.** One unified interface; the model is config, not code.
- **Local executes, cloud reviews.** The executor (often a local model) runs freely on safe steps; the reviewer (a cloud model) gates only risky/irreversible actions.
- **Memory you can see.** RAG over `sqlite-vec` plus a navigable knowledge graph — no black boxes.
- **Standard skills.** [agentskills.io](https://agentskills.io) format, so skills are portable in and out of Holt.

## Layout

```
holt/
  src/            TypeScript core (agent loop, router, dispatcher, memory)
  plugins/        first-party MCP plugins (providers, memory, channels)
  skills/         starter skill catalog
  config.example.yml
```

This document tracks the intended design during early development; expect it to evolve as the phases land.
