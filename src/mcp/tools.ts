/**
 * Holt's MCP tool set: exposes this folder's per-folder memory and skills as
 * MCP tools so external clients (Claude Code, Cursor, Codex) can recall and
 * remember from Holt. Every handler reuses the existing memory/skills code and
 * is defensive: it returns friendly text on failure rather than throwing, so a
 * transient issue never surfaces as a protocol-level tool error.
 *
 * The '__mcp__' sentinel session is passed to recall/saveFact so that ALL
 * stored memory in the folder is searchable and writable (recall excludes only
 * the current session, so a sentinel that no real turn uses sees everything),
 * mirroring how src/commands/memory.ts uses '__none__'.
 */
import type { McpTool } from './types';
import { recall, saveFact, memStats } from '../memory';
import { listSkills, loadSkill } from '../skills';

const MCP_SESSION = '__mcp__';

export function holtTools(): McpTool[] {
  return [
    {
      name: 'recall',
      description:
        "Search Holt's memory for this folder and return the most relevant remembered moments and distilled facts.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to recall.' },
          k: { type: 'number', description: 'Max results to return (default 5).' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        try {
          const query = String(args.query || '').trim();
          if (!query) return 'Provide a query to recall.';
          const k = Number(args.k) || 5;
          const hits = await recall(query, MCP_SESSION, k);
          if (hits.length === 0) return 'No relevant memory found.';
          const lines = hits.map(
            (h) => `${h.score.toFixed(2)}  (${h.turn.role})  ${h.turn.content.replace(/\s+/g, ' ').trim()}`,
          );
          return [`Recalled ${hits.length} relevant memory item(s):`, ...lines].join('\n');
        } catch (err) {
          return `Could not recall right now: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'remember',
      description: "Save a durable fact to Holt's memory for this folder.",
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact to remember.' },
        },
        required: ['content'],
      },
      handler: async (args) => {
        try {
          const content = String(args.content || '').trim();
          if (!content) return 'Nothing to remember: content was empty.';
          const ok = await saveFact(content, MCP_SESSION);
          return ok ? 'Remembered.' : 'Already known (duplicate).';
        } catch (err) {
          return `Could not remember right now: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'list_skills',
      description: 'List the skills installed for this folder (workspace and global).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          const skills = listSkills();
          if (skills.length === 0) return 'No skills installed.';
          const lines = skills.map((s) => `${s.name}: ${s.description || '(no description)'}`);
          return ['Installed skills:', ...lines].join('\n');
        } catch (err) {
          return `Could not list skills right now: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'get_skill',
      description: 'Get the full instructions (body) of a skill by name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name.' },
        },
        required: ['name'],
      },
      handler: async (args) => {
        try {
          const name = String(args.name || '').trim();
          if (!name) return 'Provide a skill name.';
          const loaded = loadSkill(name);
          if (!loaded) return `No skill named "${name}".`;
          return [`Skill: ${loaded.skill.name}`, '', loaded.body].join('\n');
        } catch (err) {
          return `Could not load that skill right now: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'memory_stats',
      description: "Show statistics for Holt's memory in this folder.",
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          const s = memStats();
          return [
            'Holt memory (this folder):',
            `moments    ${s.turns}`,
            `facts      ${s.facts}`,
            `sessions   ${s.sessions}`,
            `embedded   ${s.withEmbeddings} of ${s.turns}`,
            `size       ${(s.bytes / 1024).toFixed(1)} KB`,
          ].join('\n');
        } catch (err) {
          return `Could not read memory stats right now: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}
