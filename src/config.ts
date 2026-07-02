/**
 * Holt config, stored PER WORKSPACE at <folder>/.holt/config.json (written by
 * `holt init`). A "brain" in this phase is an agent CLI installed on your
 * machine (Claude Code, Codex, or Gemini). No API keys handled by Holt.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { wsConfigPath, ensureWsDir } from './workspace';

export type BrainId = 'claude' | 'codex' | 'gemini';

export interface BrainConfig {
  id: BrainId;
  label: string;
  command: string; // CLI on PATH, e.g. "claude"
  args: string[]; // non-interactive args; prompt appended last
  enabled: boolean; // installed + selected
}

export interface HoltConfig {
  version: number;
  defaultBrain: BrainId | null;
  brains: Record<BrainId, BrainConfig>;
}

export const BRAIN_DEFS: Record<BrainId, { label: string; command: string; args: string[] }> = {
  claude: { label: 'Claude Code', command: 'claude', args: ['-p'] },
  codex: { label: 'Codex (OpenAI)', command: 'codex', args: ['exec'] },
  gemini: { label: 'Gemini CLI', command: 'gemini', args: ['-p'] },
};

// How to install and sign in to each brain. These evolve upstream; adjust as needed.
export const BRAIN_SETUP: Record<BrainId, { install: string[]; login: string[] }> = {
  claude: { install: ['npm', 'install', '-g', '@anthropic-ai/claude-code'], login: ['claude'] },
  codex: { install: ['npm', 'install', '-g', '@openai/codex'], login: ['codex', 'login'] },
  gemini: { install: ['npm', 'install', '-g', '@google/gemini-cli'], login: ['gemini'] },
};

export const BRAIN_IDS: BrainId[] = ['claude', 'codex', 'gemini'];

export function defaultConfig(): HoltConfig {
  const brains = {} as Record<BrainId, BrainConfig>;
  for (const id of BRAIN_IDS) {
    const d = BRAIN_DEFS[id];
    brains[id] = { id, label: d.label, command: d.command, args: [...d.args], enabled: false };
  }
  return { version: 2, defaultBrain: null, brains };
}

export function loadConfig(): HoltConfig | null {
  const path = wsConfigPath();
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as HoltConfig;
    const base = defaultConfig();
    for (const id of BRAIN_IDS) if (!cfg.brains?.[id]) cfg.brains[id] = base.brains[id];
    return cfg;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: HoltConfig): void {
  ensureWsDir();
  writeFileSync(wsConfigPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
