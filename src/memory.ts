/**
 * Phase 1 memory: per-workspace, append-only JSONL at <folder>/.holt/memory/turns.jsonl.
 * Recall works two ways: embeddings via a local Ollama if one is running (no keys,
 * fully private), otherwise a keyword overlap fallback. Zero dependencies.
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { wsHoltDir, workspace, GLOBAL_DIR } from './workspace';

export interface MemTurn {
  id: string;
  ts: number;
  session: string;
  role: 'user' | 'assistant' | 'fact';
  content: string;
  emb?: number[];
}

/** A global-store row: a promoted fact plus the folder it came from. */
export interface GlobalFact extends MemTurn {
  /** Absolute path of the workspace this fact was promoted from. */
  workspace: string;
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
  // If this folder opted into global memory, mirror distilled facts (role:'fact',
  // which includes wiki page rows) to the shared store, tagged with this folder.
  // Never let a global-store hiccup break the local write.
  if (t.role === 'fact') {
    try {
      const ws = workspace();
      if (isGlobalEnabled(ws)) appendGlobalFact(t, ws);
    } catch {
      // global promotion is best-effort; local memory is the source of truth
    }
  }
}

export function clearMemory(): void {
  if (existsSync(memPath())) rmSync(memPath());
  // Also remove the distilled facts file so stats, the facts view, and fact
  // dedup all stay consistent. Leaving facts.md behind would keep showing old
  // facts and would silently block those same facts from being re-stored.
  if (existsSync(factsMdPath())) rmSync(factsMdPath());
}

// ---- facts ----

/** Normalize a fact for exact-match dedup: lowercase, collapse whitespace, strip trailing punctuation. */
export function normalizeFact(s: string): string {
  return (s || '')
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

// ---- global store (opt-in, AIOS-style single store tagged by workspace) ----
//
// Per-folder memory stays the default and the source of truth. A folder can opt
// in with `holt memory global on`; opting in both CONTRIBUTES its distilled
// facts to a shared store and READS that store during recall (excluding its own
// rows, which are already local). State lives in ~/.holt/memory-scopes.json; the
// store lives at ~/.holt/global/turns.jsonl. Nothing here changes behavior for a
// folder that never opts in.

export function globalMemDir(): string {
  return join(GLOBAL_DIR, 'global');
}
export function globalMemPath(): string {
  return join(globalMemDir(), 'turns.jsonl');
}
export function memoryScopesPath(): string {
  return join(GLOBAL_DIR, 'memory-scopes.json');
}

interface ScopesFile {
  enabled: string[];
}

function readScopes(): ScopesFile {
  try {
    const raw = JSON.parse(readFileSync(memoryScopesPath(), 'utf8')) as Partial<ScopesFile>;
    return { enabled: Array.isArray(raw.enabled) ? raw.enabled.filter((s) => typeof s === 'string') : [] };
  } catch {
    return { enabled: [] };
  }
}

function writeScopes(s: ScopesFile): void {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(memoryScopesPath(), JSON.stringify({ enabled: s.enabled }, null, 2) + '\n', 'utf8');
}

/** Is the given workspace opted into global memory (contribute + read)? */
export function isGlobalEnabled(ws: string = workspace()): boolean {
  try {
    return readScopes().enabled.includes(ws);
  } catch {
    return false;
  }
}

/** Absolute paths of all folders currently contributing to / reading the global store. */
export function globalWorkspaces(): string[] {
  return readScopes().enabled.slice();
}

/** Load every row from the global store. Corrupt/missing store degrades to []. */
export function loadGlobalFacts(): GlobalFact[] {
  try {
    if (!existsSync(globalMemPath())) return [];
    const out: GlobalFact[] = [];
    for (const line of readFileSync(globalMemPath(), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as GlobalFact;
        if (row && typeof row.content === 'string' && typeof row.workspace === 'string') out.push(row);
      } catch {
        // skip corrupt lines rather than losing the whole store
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Append a fact to the global store tagged with its workspace. Dedups by
 * (normalized content + workspace) so re-saves and re-syncs never pile up.
 * Never throws. Returns true when a new row was written.
 */
export function appendGlobalFact(t: MemTurn, ws: string): boolean {
  try {
    const norm = normalizeFact(t.content);
    for (const g of loadGlobalFacts()) {
      if (g.workspace === ws && normalizeFact(g.content) === norm) return false;
    }
    mkdirSync(globalMemDir(), { recursive: true });
    const row: GlobalFact = {
      id: t.id,
      ts: t.ts,
      session: t.session,
      role: 'fact',
      content: t.content,
      workspace: ws,
      ...(Array.isArray(t.emb) ? { emb: t.emb } : {}),
    };
    appendFileSync(globalMemPath(), JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Enable global memory for a folder and backfill its existing facts into the store. Returns rows backfilled. */
export function enableGlobal(ws: string = workspace()): number {
  const s = readScopes();
  if (!s.enabled.includes(ws)) {
    s.enabled.push(ws);
    writeScopes(s);
  }
  // Backfill existing local fact rows (dedup handles the already-present ones).
  let added = 0;
  for (const t of loadTurns()) {
    if (t.role === 'fact' && appendGlobalFact(t, ws)) added++;
  }
  return added;
}

/**
 * Disable global memory for a folder. With purge, also drop this folder's rows
 * from the shared store. Returns { purged } row count removed (0 unless purge).
 */
export function disableGlobal(ws: string = workspace(), purge = false): { purged: number } {
  const s = readScopes();
  const next = s.enabled.filter((w) => w !== ws);
  if (next.length !== s.enabled.length) writeScopes({ enabled: next });

  if (!purge) return { purged: 0 };
  try {
    const all = loadGlobalFacts();
    const kept = all.filter((g) => g.workspace !== ws);
    const purged = all.length - kept.length;
    if (purged > 0) {
      mkdirSync(globalMemDir(), { recursive: true });
      writeFileSync(globalMemPath(), kept.map((g) => JSON.stringify(g)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
    }
    return { purged };
  } catch {
    return { purged: 0 };
  }
}

export interface GlobalStats {
  facts: number;
  workspaces: number;
  bytes: number;
}

export function globalStats(): GlobalStats {
  const rows = loadGlobalFacts();
  const workspaces = new Set(rows.map((r) => r.workspace)).size;
  let bytes = 0;
  try {
    bytes = existsSync(globalMemPath()) ? statSync(globalMemPath()).size : 0;
  } catch {
    bytes = 0;
  }
  return { facts: rows.length, workspaces, bytes };
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
    (s || '')
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
  /**
   * Absolute path of the folder a global-store hit came from. Absent for local
   * hits (which belong to the current folder). Additive: existing consumers can
   * ignore it. When present, the hit was recalled from the shared global store.
   */
  workspace?: string;
}

/** Distilled facts rank slightly higher than raw turns once above threshold. */
const FACT_BOOST = 1.15;

/** Score one row against the query, returning null if it fails the threshold. */
function scoreRow(
  content: string,
  emb: number[] | undefined,
  role: MemTurn['role'],
  qEmb: number[] | null,
  qTok: Set<string>,
): number | null {
  const useEmb = qEmb && Array.isArray(emb);
  let score = useEmb ? cosine(qEmb, emb as number[]) : keywordScore(qTok, content);
  if (score > (useEmb ? 0.35 : 0.15)) {
    // Boost only after passing the threshold, so a weak fact never sneaks through.
    if (role === 'fact') score *= FACT_BOOST;
    return score;
  }
  return null;
}

/**
 * Top-k relevant turns from PAST sessions (never the current one).
 *
 * For a folder opted into global memory, also scores the shared global store
 * (excluding this folder's own rows, which are already local) and merges the
 * results, tagging each global hit with its source workspace. A missing or
 * corrupt global store degrades to local-only recall.
 */
export async function recall(query: string, currentSession: string, k = 4): Promise<Recalled[]> {
  const ws = workspace();
  const past = loadTurns().filter((t) => t.session !== currentSession);

  const qEmb = await embed(query);
  const qTok = tokens(query);
  const scored: Recalled[] = [];

  for (const turn of past) {
    const score = scoreRow(turn.content, turn.emb, turn.role, qEmb, qTok);
    if (score !== null) scored.push({ turn, score });
  }

  if (isGlobalEnabled(ws)) {
    for (const g of loadGlobalFacts()) {
      // Skip our own rows: they are already scored above from local memory.
      if (g.workspace === ws) continue;
      const score = scoreRow(g.content, g.emb, g.role, qEmb, qTok);
      if (score !== null) {
        scored.push({
          turn: { id: g.id, ts: g.ts, session: g.session, role: g.role, content: g.content, emb: g.emb },
          score,
          workspace: g.workspace,
        });
      }
    }
  }

  if (scored.length === 0) return [];
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
