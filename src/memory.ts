/**
 * Phase 1 memory: per-workspace, append-only JSONL at <folder>/.holt/memory/turns.jsonl.
 * Recall works two ways: embeddings via a local Ollama if one is running (no keys,
 * fully private), otherwise a keyword overlap fallback. Zero dependencies.
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { wsHoltDir } from './workspace';

export interface MemTurn {
  id: string;
  ts: number;
  session: string;
  role: 'user' | 'assistant' | 'fact';
  content: string;
  emb?: number[];
}

const OLLAMA_URL = process.env.HOLT_OLLAMA_URL || 'http://127.0.0.1:11434';
export const EMBED_MODEL = process.env.HOLT_EMBED_MODEL || 'nomic-embed-text';

export function memDir(): string {
  return join(wsHoltDir(), 'memory');
}
export function memPath(): string {
  return join(memDir(), 'turns.jsonl');
}
export function factsMdPath(): string {
  return join(memDir(), 'facts.md');
}
export function newSessionId(): string {
  return randomUUID().slice(0, 8);
}

// ---- embeddings (optional, local) ----

let embedProbe: boolean | null = null;

/** Forget the probe result (used after init installs Ollama or pulls the model). */
export function resetEmbedProbe(): void {
  embedProbe = null;
}

/** Is a local Ollama with the embed model reachable? Probed once per process. */
export async function embeddingsAvailable(): Promise<boolean> {
  if (embedProbe !== null) return embedProbe;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return (embedProbe = false);
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    embedProbe = !!data.models?.some((m) => (m.name || '').startsWith(EMBED_MODEL));
  } catch {
    embedProbe = false;
  }
  return embedProbe;
}

export async function embed(text: string): Promise<number[] | null> {
  if (!(await embeddingsAvailable())) return null;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) return null;
    // Round to shrink the JSONL; plenty of precision for cosine ranking.
    return data.embedding.map((x) => Math.round(x * 1e4) / 1e4);
  } catch {
    return null;
  }
}

// ---- store ----

export function loadTurns(): MemTurn[] {
  if (!existsSync(memPath())) return [];
  const out: MemTurn[] = [];
  for (const line of readFileSync(memPath(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as MemTurn);
    } catch {
      // skip corrupt lines rather than losing the whole store
    }
  }
  return out;
}

export function appendTurn(t: MemTurn): void {
  mkdirSync(memDir(), { recursive: true });
  appendFileSync(memPath(), JSON.stringify(t) + '\n', 'utf8');
}

export function clearMemory(): void {
  if (existsSync(memPath())) rmSync(memPath());
}

// ---- facts ----

/** Normalize a fact for exact-match dedup: lowercase, collapse whitespace, strip trailing punctuation. */
function normalizeFact(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/, '');
}

const FACTS_HEADER = '# Holt facts\n\nDistilled memories for this folder. Safe to edit by hand.\n';

/**
 * Save a distilled fact. Dedups (normalized exact match) against existing
 * role:'fact' rows and lines already in facts.md. On a new fact: appends a
 * human-readable bullet to facts.md under a single dated heading, and appends
 * an embedded recall row to turns.jsonl. Returns false when it was a duplicate.
 */
export async function saveFact(content: string, session: string): Promise<boolean> {
  const clean = content.trim();
  if (!clean) return false;
  const norm = normalizeFact(clean);

  // Dedup against existing fact rows in the jsonl.
  for (const t of loadTurns()) {
    if (t.role === 'fact' && normalizeFact(t.content) === norm) return false;
  }
  // Dedup against lines already written to facts.md.
  if (existsSync(factsMdPath())) {
    for (const line of readFileSync(factsMdPath(), 'utf8').split('\n')) {
      const l = line.trim();
      if (!l.startsWith('- ')) continue;
      if (normalizeFact(l.slice(2)) === norm) return false;
    }
  }

  mkdirSync(memDir(), { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  let existing = existsSync(factsMdPath()) ? readFileSync(factsMdPath(), 'utf8') : '';
  if (!existing) existing = FACTS_HEADER;

  // Find the last dated heading; write today's heading only if it is not already the last.
  const headings = existing.match(/^## (\d{4}-\d{2}-\d{2})/gm);
  const lastHeading = headings && headings.length ? headings[headings.length - 1] : null;
  const needsHeading = lastHeading !== `## ${today}`;

  let addition = '';
  if (needsHeading) {
    if (!existing.endsWith('\n')) addition += '\n';
    addition += `\n## ${today}\n`;
  }
  addition += `- ${clean}\n`;

  writeFileSync(factsMdPath(), existing + addition, 'utf8');

  appendTurn({
    id: randomUUID().slice(0, 8),
    ts: Date.now(),
    session,
    role: 'fact',
    content: clean,
    emb: (await embed(clean)) ?? undefined,
  });
  return true;
}

export interface MemStats {
  turns: number;
  facts: number;
  sessions: number;
  withEmbeddings: number;
  bytes: number;
}

export function memStats(): MemStats {
  const turns = loadTurns();
  const sessions = new Set(turns.map((t) => t.session)).size;
  const withEmbeddings = turns.filter((t) => Array.isArray(t.emb)).length;
  const facts = turns.filter((t) => t.role === 'fact').length;
  const bytes = existsSync(memPath()) ? statSync(memPath()).size : 0;
  return { turns: turns.length, facts, sessions, withEmbeddings, bytes };
}

// ---- recall ----

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

function keywordScore(q: Set<string>, text: string): number {
  if (q.size === 0) return 0;
  const t = tokens(text);
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  return hit / q.size;
}

export interface Recalled {
  turn: MemTurn;
  score: number;
}

/** Distilled facts rank slightly higher than raw turns once above threshold. */
const FACT_BOOST = 1.15;

/** Top-k relevant turns from PAST sessions (never the current one). */
export async function recall(query: string, currentSession: string, k = 4): Promise<Recalled[]> {
  const past = loadTurns().filter((t) => t.session !== currentSession);
  if (past.length === 0) return [];

  const qEmb = await embed(query);
  const qTok = tokens(query);
  const scored: Recalled[] = [];

  for (const turn of past) {
    let score = 0;
    if (qEmb && Array.isArray(turn.emb)) score = cosine(qEmb, turn.emb);
    else score = keywordScore(qTok, turn.content);
    if (score > (qEmb && Array.isArray(turn.emb) ? 0.35 : 0.15)) {
      // Boost only after passing the threshold, so a weak fact never sneaks through.
      if (turn.role === 'fact') score *= FACT_BOOST;
      scored.push({ turn, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ---- backfill ----

/** Embed every stored turn that lacks a vector, then rewrite the store. */
export async function backfillEmbeddings(
  onProgress?: (done: number, total: number) => void,
): Promise<{ embedded: number; total: number }> {
  const turns = loadTurns();
  const missing = turns.filter((t) => !Array.isArray(t.emb));
  if (missing.length === 0) return { embedded: 0, total: 0 };

  let done = 0;
  let embedded = 0;
  for (const t of missing) {
    const e = await embed(t.content);
    if (e) {
      t.emb = e;
      embedded++;
    }
    done++;
    if (onProgress) onProgress(done, missing.length);
  }

  mkdirSync(memDir(), { recursive: true });
  writeFileSync(memPath(), turns.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8');
  return { embedded, total: missing.length };
}
