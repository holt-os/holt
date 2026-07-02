/**
 * Phase 1 memory: per-workspace, append-only JSONL at <folder>/.holt/memory/turns.jsonl.
 * Recall works two ways: embeddings via a local Ollama if one is running (no keys,
 * fully private), otherwise a keyword overlap fallback. Zero dependencies.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { wsHoltDir } from './workspace';

export interface MemTurn {
  id: string;
  ts: number;
  session: string;
  role: 'user' | 'assistant';
  content: string;
  emb?: number[];
}

const OLLAMA_URL = process.env.HOLT_OLLAMA_URL || 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.HOLT_EMBED_MODEL || 'nomic-embed-text';

export function memDir(): string {
  return join(wsHoltDir(), 'memory');
}
export function memPath(): string {
  return join(memDir(), 'turns.jsonl');
}
export function newSessionId(): string {
  return randomUUID().slice(0, 8);
}

// ---- embeddings (optional, local) ----

let embedProbe: boolean | null = null;

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

export interface MemStats {
  turns: number;
  sessions: number;
  withEmbeddings: number;
  bytes: number;
}

export function memStats(): MemStats {
  const turns = loadTurns();
  const sessions = new Set(turns.map((t) => t.session)).size;
  const withEmbeddings = turns.filter((t) => Array.isArray(t.emb)).length;
  const bytes = existsSync(memPath()) ? statSync(memPath()).size : 0;
  return { turns: turns.length, sessions, withEmbeddings, bytes };
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
    if (score > (qEmb && Array.isArray(turn.emb) ? 0.35 : 0.15)) scored.push({ turn, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
