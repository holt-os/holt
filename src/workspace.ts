/**
 * Workspace + trust. Holt operates in the folder you launch it from (like a
 * per-project tool). Trusted folders are remembered globally in ~/.holt/trust.json.
 * Per-workspace data (config, and later memory) lives in <folder>/.holt/.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { c, type Ask } from './ui';

export const GLOBAL_DIR = join(homedir(), '.holt');
export const TRUST_PATH = join(GLOBAL_DIR, 'trust.json');

export function workspace(): string {
  return process.cwd();
}
export function wsHoltDir(dir: string = workspace()): string {
  return join(dir, '.holt');
}
export function wsConfigPath(dir: string = workspace()): string {
  return join(wsHoltDir(dir), 'config.json');
}

interface TrustFile {
  trusted: string[];
}
function readTrust(): TrustFile {
  try {
    return JSON.parse(readFileSync(TRUST_PATH, 'utf8')) as TrustFile;
  } catch {
    return { trusted: [] };
  }
}

export function isTrusted(dir: string = workspace()): boolean {
  return readTrust().trusted.includes(dir);
}

export function trustDir(dir: string = workspace()): void {
  const t = readTrust();
  if (!t.trusted.includes(dir)) t.trusted.push(dir);
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(TRUST_PATH, JSON.stringify(t, null, 2) + '\n', 'utf8');
}

/** Prompt to trust the current folder if it is not already trusted. Returns false if declined. */
export async function ensureTrusted(ask: Ask): Promise<boolean> {
  const ws = workspace();
  if (isTrusted(ws)) return true;
  console.log('\n' + c.accent('Trust this folder?'));
  console.log('  ' + ws);
  console.log(c.dim('  Holt will read and write here: its config, memory, and any files you ask a brain to touch.'));
  const ans = ((await ask('  Trust and continue? [y/N] ')) ?? '').trim().toLowerCase();
  if (ans === 'y' || ans === 'yes') {
    trustDir(ws);
    console.log(c.green('  Trusted.') + c.dim(' (remembered for next time)') + '\n');
    return true;
  }
  console.log(c.dim('  Cancelled. Holt only runs in folders you trust.\n'));
  return false;
}

export function ensureWsDir(): void {
  mkdirSync(wsHoltDir(), { recursive: true });
}
