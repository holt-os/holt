/**
 * Holt config, stored PER WORKSPACE at <folder>/.holt/config.json (written by
 * `holt init`). A "brain" can be an agent CLI installed on your machine (Claude
 * Code, Codex, or Gemini), or a direct API brain that talks to a provider over
 * HTTP with your own key. CLI brains need no keys; API brains resolve a key from
 * an env var or the global credentials file.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { wsConfigPath, ensureWsDir, GLOBAL_DIR } from './workspace';

export type BrainId = 'claude' | 'codex' | 'gemini';
export type Provider = 'anthropic' | 'openai' | 'gemini';

export interface BrainConfig {
  id: BrainId;
  label: string;
  command: string; // CLI on PATH, e.g. "claude"
  args: string[]; // non-interactive args; prompt appended last
  enabled: boolean; // installed + selected
}

/** A direct API brain: user-named, talks to a provider over HTTP with a key. */
export interface ApiBrain {
  id: string; // user-chosen short name; must not collide with claude/codex/gemini
  provider: Provider;
  model: string;
  keyEnv?: string; // optional env var name that holds the key
}

export type OutputFormat = 'markdown' | 'html';

/** Memory behavior knobs. */
export interface MemorySettings {
  extractFacts: boolean;
}

/** Who maintains the derived knowledge wiki, and (for local) which model. */
export type WikiMaintainer = 'brain' | 'local';

export interface WikiSettings {
  /** 'brain' (default) uses the folder's configured brain; 'local' uses Ollama. */
  maintainer: WikiMaintainer;
  /** Ollama generative model used when maintainer is 'local'. */
  localModel: string;
  /** Reserved for a future auto-sync-on-session-end hook. Off by default. */
  autoSync?: boolean;
}

export const WIKI_DEFAULT_LOCAL_MODEL = 'qwen2.5:7b';

export interface HoltConfig {
  version: number;
  defaultBrain: string | null; // a BrainId or an ApiBrain id
  brains: Record<BrainId, BrainConfig>;
  apiBrains: ApiBrain[];
  outputFormat: OutputFormat;
  memory: MemorySettings;
  wiki: WikiSettings;
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

export const PROVIDERS: Provider[] = ['anthropic', 'openai', 'gemini'];

/** Suggested default model per provider (user may type anything). */
export const PROVIDER_MODEL_SUGGESTION: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-flash',
};

/** Standard env var each provider falls back to. */
export const PROVIDER_ENV: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export function defaultConfig(): HoltConfig {
  const brains = {} as Record<BrainId, BrainConfig>;
  for (const id of BRAIN_IDS) {
    const d = BRAIN_DEFS[id];
    brains[id] = { id, label: d.label, command: d.command, args: [...d.args], enabled: false };
  }
  return {
    version: 5,
    defaultBrain: null,
    brains,
    apiBrains: [],
    outputFormat: 'markdown',
    memory: { extractFacts: true },
    wiki: { maintainer: 'brain', localModel: WIKI_DEFAULT_LOCAL_MODEL },
  };
}

export function loadConfig(): HoltConfig | null {
  const path = wsConfigPath();
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<HoltConfig>;
    const base = defaultConfig();
    // Graceful migration from v2 (and any missing field): fill defaults.
    const brains = (cfg.brains ?? {}) as Record<BrainId, BrainConfig>;
    for (const id of BRAIN_IDS) if (!brains[id]) brains[id] = base.brains[id];
    // Additive v4 -> v5 migration: fill the wiki block from defaults, never lose
    // existing fields. Mirrors the way the memory block was added earlier.
    const wikiIn = (cfg.wiki ?? {}) as Partial<WikiSettings>;
    const wiki: WikiSettings = {
      maintainer: wikiIn.maintainer === 'local' ? 'local' : 'brain',
      localModel:
        typeof wikiIn.localModel === 'string' && wikiIn.localModel.trim()
          ? wikiIn.localModel.trim()
          : WIKI_DEFAULT_LOCAL_MODEL,
      ...(typeof wikiIn.autoSync === 'boolean' ? { autoSync: wikiIn.autoSync } : {}),
    };
    return {
      version: 5,
      defaultBrain: cfg.defaultBrain ?? null,
      brains,
      apiBrains: Array.isArray(cfg.apiBrains) ? cfg.apiBrains : [],
      outputFormat: cfg.outputFormat === 'html' ? 'html' : 'markdown',
      memory: {
        extractFacts:
          cfg.memory && typeof cfg.memory.extractFacts === 'boolean' ? cfg.memory.extractFacts : true,
      },
      wiki,
    };
  } catch {
    return null;
  }
}

export function saveConfig(cfg: HoltConfig): void {
  ensureWsDir();
  writeFileSync(wsConfigPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// ---- API brain helpers ----

/** True if an id would clash with a built-in CLI brain. */
export function isReservedBrainId(id: string): boolean {
  return (BRAIN_IDS as string[]).includes(id.toLowerCase());
}

export function findApiBrain(cfg: HoltConfig, id: string): ApiBrain | undefined {
  return cfg.apiBrains.find((b) => b.id === id);
}

// ---- global credentials (~/.holt/credentials.json) ----

export type Credentials = { anthropic?: string; openai?: string; gemini?: string };

export function credentialsPath(): string {
  return join(GLOBAL_DIR, 'credentials.json');
}

export function readCredentials(): Credentials {
  try {
    return JSON.parse(readFileSync(credentialsPath(), 'utf8')) as Credentials;
  } catch {
    return {};
  }
}

/** Store a provider key in the global credentials file, mode 0o600. */
export function saveCredential(provider: Provider, key: string): void {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  const creds = readCredentials();
  creds[provider] = key;
  writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

/**
 * Resolve an API key for a brain. Order: brain.keyEnv env var, then the global
 * credentials file, then the provider's standard env var. Returns null if none.
 */
export function resolveApiKey(brain: ApiBrain): string | null {
  if (brain.keyEnv) {
    const v = process.env[brain.keyEnv];
    if (v && v.trim()) return v.trim();
  }
  const creds = readCredentials();
  const stored = creds[brain.provider];
  if (stored && stored.trim()) return stored.trim();
  const std = process.env[PROVIDER_ENV[brain.provider]];
  if (std && std.trim()) return std.trim();
  return null;
}

/** Human-readable hint on how to provide a key for a brain that has none. */
export function keyHint(brain: ApiBrain): string {
  const parts: string[] = [];
  if (brain.keyEnv) parts.push(`set env var ${brain.keyEnv}`);
  parts.push(`set ${PROVIDER_ENV[brain.provider]}`);
  parts.push('or store a key via /setting > connect API brain');
  return parts.join(', ');
}
