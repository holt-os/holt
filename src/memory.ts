/**
 * Phase 1 memory: per-workspace, append-only JSONL at <folder>/.holt/memory/turns.jsonl.
 * Recall works two ways: embeddings via a local Ollama if one is running (no keys,
 * fully private), otherwise a keyword overlap fallback. Zero dependencies.
 */
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
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
  try {
    return loadIndexed(memPath());
  } catch {
    // any index problem falls back to reading turns.jsonl directly
    return readJsonl(memPath(), 0, statSync(memPath()).size);
  }
}

/** Parse JSONL rows in [start, end) without ever holding the file as one string. */
function readJsonl(path: string, start: number, end: number): MemTurn[] {
  const out: MemTurn[] = [];
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(8 << 20);
    let pos = start;
    let carry: Buffer = Buffer.alloc(0);
    const take = (line: Buffer): void => {
      const s = line.toString('utf8');
      if (!s.trim()) return;
      try {
        out.push(JSON.parse(s) as MemTurn);
      } catch {
        // skip corrupt lines rather than losing the whole store
      }
    };
    while (pos < end) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n <= 0) break;
      pos += n;
      let chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let nl: number;
      while ((nl = chunk.indexOf(10)) !== -1) {
        take(chunk.subarray(0, nl));
        chunk = chunk.subarray(nl + 1);
      }
      carry = Buffer.from(chunk);
    }
    if (carry.length) take(carry);
  } finally {
    closeSync(fd);
  }
  return out;
}

// ---- read index ----
//
// turns.jsonl stays the source of truth. Parsing it is most of recall's cost
// (each embedding is ~768 numbers of JSON text), and hooks start a fresh
// process per prompt, so loadTurns() keeps a derived index in memory/index/:
// the rows without embeddings, the embeddings as raw float64 (exact), and each
// row's BM25 token count. Appends are folded in incrementally; any other change
// to turns.jsonl rebuilds it. It is always safe to delete.

interface IdxHead {
  v: number;
  gen: string;
  size: number;
  mtimeMs: number;
  tail: string;
  rows: number;
  rowsBytes: number;
  embBytes: number;
}

const IDX_V = 1;
const rowTokens = new WeakMap<MemTurn, number>();
const rowVec = new WeakMap<MemTurn, Float64Array>();

function idxDir(): string {
  return join(memDir(), 'index');
}

function bm25Tokens(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/**
 * Fingerprint of the bytes just before `end`, to tell an append from a rewrite.
 * Includes whether they end in a newline: appending after a partial last line
 * would change how that line parses, so it must rebuild.
 */
function tailHash(path: string, end: number): string {
  const len = Math.min(4096, end);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, end - len);
  } finally {
    closeSync(fd);
  }
  return (buf.at(-1) === 10 ? 'nl:' : 'part:') + createHash('sha1').update(buf).digest('hex');
}

function readHead(): IdxHead | null {
  try {
    const h = JSON.parse(readFileSync(join(idxDir(), 'head.json'), 'utf8')) as IdxHead;
    return h.v === IDX_V ? h : null;
  } catch {
    return null;
  }
}

function readBytes(path: string, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    if (len && readSync(fd, buf, 0, len, 0) !== len) throw new Error('index truncated');
  } finally {
    closeSync(fd);
  }
  return buf;
}

function readIdx(h: IdxHead): MemTurn[] {
  const d = idxDir();
  const rows = readJsonl(join(d, `rows-${h.gen}.jsonl`), 0, h.rowsBytes);
  const meta = new Uint32Array(readBytes(join(d, `meta-${h.gen}.u32`), h.rows * 8).buffer);
  const emb = new Float64Array(readBytes(join(d, `emb-${h.gen}.f64`), h.embBytes).buffer);
  if (rows.length !== h.rows) throw new Error('index row count mismatch');
  let off = 0;
  rows.forEach((r, i) => {
    const dims = meta[i * 2] as number;
    rowTokens.set(r, meta[i * 2 + 1] as number);
    if (!dims) return;
    // Recall scores straight from the float64 view; the number[] that callers
    // see (and that gets written back to turns.jsonl) is only built if read.
    const vec = emb.subarray(off, (off += dims));
    rowVec.set(r, vec);
    let arr: number[] | undefined;
    Object.defineProperty(r, 'emb', {
      enumerable: true,
      configurable: true,
      get: () => (arr ??= Array.from(vec)),
      set: (v: number[] | undefined) => {
        rowVec.delete(r);
        Object.defineProperty(r, 'emb', { value: v, enumerable: true, writable: true, configurable: true });
      },
    });
  });
  if (off * 8 !== h.embBytes) throw new Error('index embedding size mismatch');
  return rows;
}

/** Serialise rows into the three index parts. */
function encodeIdx(rows: MemTurn[]): { rows: string; meta: Buffer; emb: Buffer } {
  const meta = new Uint32Array(rows.length * 2);
  let dims = 0;
  for (const r of rows) dims += Array.isArray(r.emb) ? r.emb.length : 0;
  const emb = new Float64Array(dims);
  let off = 0;
  const lines = rows.map((r, i) => {
    const { emb: e, ...rest } = r;
    if (Array.isArray(e)) {
      emb.set(e, off);
      off += e.length;
      meta[i * 2] = e.length;
    }
    const n = bm25Tokens(r.content).length;
    meta[i * 2 + 1] = n;
    rowTokens.set(r, n);
    return JSON.stringify(rest) + '\n';
  });
  return { rows: lines.join(''), meta: Buffer.from(meta.buffer), emb: Buffer.from(emb.buffer) };
}

function writeHead(h: IdxHead): void {
  const tmp = join(idxDir(), `head.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(h));
  renameSync(tmp, join(idxDir(), 'head.json'));
}

/** One writer at a time; a reader that loses the race just skips the index update. */
function lockIdx(): (() => void) | null {
  const lock = join(idxDir(), 'lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(idxDir(), { recursive: true });
      const fd = openSync(lock, 'wx');
      return () => {
        closeSync(fd);
        rmSync(lock, { force: true });
      };
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs < 30_000) return null;
        rmSync(lock, { force: true }); // stale lock from a crashed process
      } catch {
        return null;
      }
    }
  }
  return null;
}

function loadIndexed(path: string): MemTurn[] {
  const st = statSync(path);
  const head = readHead();
  if (head && head.size === st.size && head.mtimeMs === st.mtimeMs) return readIdx(head);

  const unlock = lockIdx();
  try {
    const appended =
      head && st.size > head.size && head.tail.startsWith('nl:') && tailHash(path, head.size) === head.tail;
    if (head && appended) {
      const base = readIdx(head);
      const more = readJsonl(path, head.size, st.size);
      if (unlock) {
        const enc = encodeIdx(more);
        const d = idxDir();
        appendFileSync(join(d, `rows-${head.gen}.jsonl`), enc.rows);
        appendFileSync(join(d, `meta-${head.gen}.u32`), enc.meta);
        appendFileSync(join(d, `emb-${head.gen}.f64`), enc.emb);
        writeHead({
          ...head,
          size: st.size,
          mtimeMs: st.mtimeMs,
          tail: tailHash(path, st.size),
          rows: head.rows + more.length,
          rowsBytes: head.rowsBytes + Buffer.byteLength(enc.rows),
          embBytes: head.embBytes + enc.emb.length,
        });
      }
      return base.concat(more);
    }

    const rows = readJsonl(path, 0, st.size);
    if (unlock) {
      const gen = randomUUID().slice(0, 8);
      const d = idxDir();
      const enc = encodeIdx(rows);
      writeFileSync(join(d, `rows-${gen}.jsonl`), enc.rows);
      writeFileSync(join(d, `meta-${gen}.u32`), enc.meta);
      writeFileSync(join(d, `emb-${gen}.f64`), enc.emb);
      writeHead({
        v: IDX_V,
        gen,
        size: st.size,
        mtimeMs: st.mtimeMs,
        tail: tailHash(path, st.size),
        rows: rows.length,
        rowsBytes: Buffer.byteLength(enc.rows),
        embBytes: enc.emb.length,
      });
      // Drop older generations so text removed from turns.jsonl is gone from disk too.
      for (const f of readdirSync(d)) if (/^(rows|meta|emb)-/.test(f) && !f.includes(gen)) rmSync(join(d, f), { force: true });
    }
    return rows;
  } finally {
    unlock?.();
  }
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
  // The read index holds copies of every row, so a real forget removes it too.
  rmSync(idxDir(), { recursive: true, force: true });
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

const FACTS_HEADER =
  '# Holt facts\n\nDistilled memories for this folder. Edit or delete lines freely.\n' +
  'To ADD one, use `holt memory add "<fact>"`: a line typed in here by hand is\n' +
  'never embedded, so semantic recall will not find it.\n';

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

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
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

// ---- context recall (v2) ----
//
// recall() returns the top-k single rows. That loses the surrounding exchange,
// the date, and anything past the first 500 chars once rendered. recallContext()
// keeps recall()'s privacy and storage model but returns a dated, chronological
// slice of the store, sized to a character budget:
//   1. score every past row with a hybrid of embedding cosine and BM25 keywords
//   2. take the top k rows, add each row's neighbours in the same session
//   3. group by session, order by time, trim to the budget
// Tunables: HOLT_RECALL_K, HOLT_RECALL_NEIGHBORS, HOLT_RECALL_BUDGET (chars).

export interface ContextRow {
  role: MemTurn['role'];
  content: string;
  ts: number;
  hit: boolean;
}
export interface ContextBlock {
  session: string;
  ts: number;
  rows: ContextRow[];
}
export interface MemoryContext {
  blocks: ContextBlock[];
  hits: number;
  chars: number;
}

const envNum = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const isTokenChar = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);

/**
 * Query-word counts for one lowercased row, without tokenising it. A token is a
 * maximal [a-z0-9] run, so w is a token exactly where it sits between non-token
 * characters. Entries come back in first-occurrence order, as tokenising gives.
 */
function queryCounts(lc: string, words: string[]): Map<string, number> {
  const found: Array<[string, number, number]> = [];
  for (const w of words) {
    let count = 0;
    let first = -1;
    for (let p = lc.indexOf(w); p !== -1; p = lc.indexOf(w, p + 1)) {
      const end = p + w.length;
      if ((p === 0 || !isTokenChar(lc.charCodeAt(p - 1))) && (end === lc.length || !isTokenChar(lc.charCodeAt(end)))) {
        if (first < 0) first = p;
        count++;
      }
    }
    if (count) found.push([w, count, first]);
  }
  return new Map(found.sort((a, b) => a[2] - b[2]).map(([w, c]) => [w, c]));
}

function bm25Scores(query: Set<string>, docs: string[], lens: Array<number | undefined> = []): number[] {
  // Rows whose token count is known (from the read index) are counted with
  // string search; the rest are tokenised. Both give the same lengths and counts.
  const words = [...query];
  const rows = docs.map((d, i) => {
    const n = lens[i];
    if (n !== undefined) return { n, tf: n ? queryCounts((d || '').toLowerCase(), words) : new Map<string, number>() };
    const t = bm25Tokens(d);
    const tf = new Map<string, number>();
    for (const w of t) if (query.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
    return { n: t.length, tf };
  });
  const N = rows.length || 1;
  const avg = rows.reduce((a, r) => a + r.n, 0) / N || 1;
  const df = new Map<string, number>();
  for (const r of rows) for (const w of r.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  return rows.map(({ n: len, tf }) => {
    if (!len) return 0;
    let s = 0;
    for (const [w, f] of tf) {
      const n = df.get(w) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avg));
    }
    return s;
  });
}

export async function recallContext(
  query: string,
  currentSession: string,
  opts: { k?: number; neighbors?: number; budget?: number; rowCap?: number; neighborCap?: number; userBoost?: number } = {},
): Promise<MemoryContext> {
  const k = opts.k ?? envNum('HOLT_RECALL_K', 32);
  const nb = opts.neighbors ?? envNum('HOLT_RECALL_NEIGHBORS', 1);
  const budget = opts.budget ?? envNum('HOLT_RECALL_BUDGET', 24000);
  const rowCap = opts.rowCap ?? envNum('HOLT_RECALL_ROWCAP', 2000);
  // Rows pulled in only as neighbours of a hit get a shorter cap: they are there
  // for context, and long assistant replies would otherwise crowd out the user's
  // own statements, which is where facts about the user live.
  const neighborCap = opts.neighborCap ?? envNum('HOLT_RECALL_NEIGHBOR_CAP', 250);
  const userBoost = opts.userBoost ?? envNum('HOLT_RECALL_USER_BOOST', 1.15);

  const all = loadTurns();
  // Folders opted into global memory also search the shared fact store, as
  // recall() does. Each source folder becomes its own pseudo-session so
  // neighbour expansion never crosses folders. Our own rows are already local.
  try {
    const ws = workspace();
    if (isGlobalEnabled(ws)) {
      for (const g of loadGlobalFacts()) {
        if (g.workspace === ws) continue;
        all.push({ id: g.id, ts: g.ts, session: `global:${g.workspace}`, role: g.role, content: g.content, emb: g.emb });
      }
    }
  } catch {
    // a missing or corrupt global store degrades to local-only recall
  }
  const at = (i: number): MemTurn => all[i] as MemTurn;
  const pastIdx: number[] = [];
  all.forEach((t, i) => {
    if (t.session !== currentSession) pastIdx.push(i);
  });
  if (!pastIdx.length) return { blocks: [], hits: 0, chars: 0 };

  const qEmb = await embed(query);
  const qTok = tokens(query);
  const bm = bm25Scores(
    qTok,
    pastIdx.map((i) => at(i).content),
    pastIdx.map((i) => rowTokens.get(at(i))),
  );
  const bmMax = Math.max(0, ...bm) || 1;

  const scored: Array<{ i: number; s: number }> = [];
  pastIdx.forEach((i, j) => {
    const t = at(i);
    const vec = rowVec.get(t) ?? (Array.isArray(t.emb) ? t.emb : null);
    const cos = qEmb && vec ? cosine(qEmb, vec) : 0;
    const kw = (bm[j] ?? 0) / bmMax;
    // Embeddings carry most of the weight when present; keywords rescue exact
    // names, numbers and rare terms that embeddings blur.
    let s = qEmb ? 0.75 * cos + 0.25 * kw : kw;
    if (s <= (qEmb ? 0.3 : 0.1)) return;
    if (t.role === 'fact') s *= FACT_BOOST;
    else if (t.role === 'user') s *= userBoost;
    scored.push({ i, s });
  });
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, k);
  if (!top.length) return { blocks: [], hits: 0, chars: 0 };

  // Expand each hit with neighbours from the same session (file order = time order).
  const pick = new Map<number, boolean>(); // index -> isHit
  for (const { i } of top) {
    pick.set(i, true);
    for (let d = 1; d <= nb; d++) {
      for (const j of [i - d, i + d]) {
        const t = all[j];
        if (t && t.session === at(i).session && t.session !== currentSession && !pick.has(j)) pick.set(j, false);
      }
    }
  }

  // Budget: keep hits in score order first, then neighbours, until full.
  const rank = new Map(top.map(({ i }, r) => [i, r]));
  const order = [...pick.keys()].sort((a, b) => {
    const ra = rank.get(a) ?? Infinity;
    const rb = rank.get(b) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return a - b;
  });
  const kept = new Set<number>();
  let chars = 0;
  const capOf = (i: number): number => (pick.get(i) ? rowCap : neighborCap);
  for (const i of order) {
    const len = Math.min(at(i).content.length, capOf(i));
    if (chars + len > budget && kept.size) continue;
    kept.add(i);
    chars += len;
  }

  const bySession = new Map<string, number[]>();
  for (const i of [...kept].sort((a, b) => a - b)) {
    const s = at(i).session;
    if (!bySession.has(s)) bySession.set(s, []);
    bySession.get(s)!.push(i);
  }
  const blocks: ContextBlock[] = [...bySession.entries()].map(([session, idx]) => ({
    session,
    ts: Math.min(...idx.map((i) => at(i).ts)),
    rows: idx.map((i) => ({
      role: at(i).role,
      content: at(i).content.length > capOf(i) ? at(i).content.slice(0, capOf(i)) + ' …' : at(i).content,
      ts: at(i).ts,
      hit: !!pick.get(i),
    })),
  }));
  blocks.sort((a, b) => a.ts - b.ts);
  return { blocks, hits: top.length, chars };
}

const isoDay = (ts: number): string => {
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return 'unknown date';
  }
};

/** Render recallContext() output as a dated, oldest-first notes block. */
export function formatMemoryContext(ctx: MemoryContext, now: Date | string = new Date()): string {
  if (!ctx.blocks.length) return '';
  const today = typeof now === 'string' ? now : isoDay(now.getTime());
  const out: string[] = [
    `Today is ${today}. Notes from this user's earlier sessions follow, oldest first, each with its date.`,
    'If notes disagree, the most recent one is current. Work out dates and durations from the session dates.',
    'To count or total something, first list every matching item across all sessions, then answer. If the notes do not cover it, say so.',
  ];
  for (const b of ctx.blocks) {
    out.push('', `### Session on ${isoDay(b.ts)}`);
    for (const r of b.rows) {
      const who = r.role === 'user' ? 'User' : r.role === 'assistant' ? 'Assistant' : 'Fact';
      out.push(`${who}: ${r.content.trim()}`);
    }
  }
  return out.join('\n');
}
