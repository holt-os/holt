/**
 * Holt config: stored at ~/.holt/config.json (written by `holt init`).
 * A "brain" in Phase 0 is an agent CLI already installed on your machine
 * (Claude Code, Codex, or Gemini CLI). No API keys required.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

export const HOLT_DIR = join(homedir(), '.holt');
export const CONFIG_PATH = join(HOLT_DIR, 'config.json');

export type BrainId = 'claude' | 'codex' | 'gemini';

export interface BrainConfig {
  id: BrainId;
  label: string;
  command: string;   // the CLI on your PATH, e.g. "claude"
  args: string[];    // non-interactive args; the prompt is appended as the last arg
  enabled: boolean;  // detected on PATH at init time
}

export interface HoltConfig {
  version: number;
  alias: string | null;          // custom launch command, e.g. "ai"
  defaultBrain: BrainId | null;
  brains: Record<BrainId, BrainConfig>;
}

// Known agent CLIs and how to call them non-interactively.
export const BRAIN_DEFS: Record<BrainId, { label: string; command: string; args: string[] }> = {
  claude: { label: 'Claude Code', command: 'claude', args: ['-p'] },
  codex: { label: 'Codex (OpenAI)', command: 'codex', args: ['exec'] },
  gemini: { label: 'Gemini CLI', command: 'gemini', args: ['-p'] },
};

export const BRAIN_IDS: BrainId[] = ['claude', 'codex', 'gemini'];

export function defaultConfig(): HoltConfig {
  const brains = {} as Record<BrainId, BrainConfig>;
  for (const id of BRAIN_IDS) {
    const d = BRAIN_DEFS[id];
    brains[id] = { id, label: d.label, command: d.command, args: [...d.args], enabled: false };
  }
  return { version: 1, alias: null, defaultBrain: null, brains };
}

export function loadConfig(): HoltConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as HoltConfig;
    // Merge in any brains missing from an older config.
    const base = defaultConfig();
    for (const id of BRAIN_IDS) if (!cfg.brains?.[id]) cfg.brains[id] = base.brains[id];
    return cfg;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: HoltConfig): void {
  mkdirSync(HOLT_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
