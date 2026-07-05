/**
 * Layer 3 memory: a derived, LLM-maintained knowledge wiki over per-folder
 * memory. Raw turns (turns.jsonl) and distilled facts (facts.md) stay
 * authoritative; wiki pages are DERIVED and REGENERABLE. Every page records the
 * fact/turn ids it drew from (provenance) so `holt wiki rebuild` can rebuild the
 * whole wiki from scratch: a bad synthesis is never lossy.
 *
 * Obsidian-compatible: pages are Markdown with small frontmatter and
 * [[wikilinks]], stored flat at <folder>/.holt/wiki/*.md with an index.md.
 *
 * Zero dependencies. Reuses embed()/cosine-style routing from memory.ts and the
 * brain-call pattern from facts.ts.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { totalmem } from 'node:os';
import { wsHoltDir } from './workspace';
import { sanitizeName, parseFrontmatter } from './skills';
import { embed, loadTurns, appendTurn, type MemTurn } from './memory';
import { runBrain } from './brains';
import { runApiBrain } from './apibrain';
import { localGenerate, localModelStatus, pullHint } from './localmodel';
import type { BrainId, ApiBrain, HoltConfig } from './config';

// ---- paths ----

export function wikiDir(): string {
  return join(wsHoltDir(), 'wiki');
}
export function wikiStatePath(): string {
  return join(wikiDir(), '.state.json');
}
export function wikiIndexPath(): string {
  return join(wikiDir(), 'index.md');
}
function pagePath(slug: string): string {
  return join(wikiDir(), `${slug}.md`);
}

// ---- state (last-sync marker) ----

export interface WikiState {
  lastSyncTs: number; // highest turn ts folded into the wiki so far
  updatedAt: number;
}

export function loadState(): WikiState {
  try {
    const s = JSON.parse(readFileSync(wikiStatePath(), 'utf8')) as Partial<WikiState>;
    return { lastSyncTs: typeof s.lastSyncTs === 'number' ? s.lastSyncTs : 0, updatedAt: s.updatedAt ?? 0 };
  } catch {
    return { lastSyncTs: 0, updatedAt: 0 };
  }
}

export function saveState(s: WikiState): void {
  mkdirSync(wikiDir(), { recursive: true });
  writeFileSync(wikiStatePath(), JSON.stringify(s, null, 2) + '\n', 'utf8');
}

/** Advance the last-sync marker to the given ts. */
export function saveSyncMarker(ts: number): void {
  saveState({ lastSyncTs: ts, updatedAt: Date.now() });
}

// ---- page model ----

export interface WikiPage {
  slug: string; // filename stem, sanitized
  title: string;
  updated: string; // ISO date
  sources: string[]; // fact/turn ids this page drew from (provenance)
  body: string; // synthesized prose (without frontmatter)
}

function isPageFile(name: string): boolean {
  return name.endsWith('.md') && name !== 'index.md';
}

export function listPageSlugs(): string[] {
  const dir = wikiDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(isPageFile)
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export function readPage(slug: string): WikiPage | null {
  const p = pagePath(slug);
  if (!existsSync(p)) return null;
  let raw = '';
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  return {
    slug,
    title: data.title || slug,
    updated: data.updated || '',
    sources: parseSources(data.sources),
    body,
  };
}

export function loadPages(): WikiPage[] {
  const out: WikiPage[] = [];
  for (const slug of listPageSlugs()) {
    const pg = readPage(slug);
    if (pg) out.push(pg);
  }
  return out;
}

/** sources frontmatter is a comma or space separated list of short ids. */
function parseSources(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .map((s) => s.replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

const PAGE_HEADER_NOTE =
  'Derived page, maintained by Holt. Safe to edit; a rebuild will regenerate it from facts.';

/** Serialize a page to Obsidian-friendly Markdown with frontmatter. */
export function renderPage(pg: WikiPage): string {
  const fm = [
    '---',
    `title: ${pg.title}`,
    `updated: ${pg.updated}`,
    `sources: ${pg.sources.join(', ')}`,
    '---',
    '',
    `> ${PAGE_HEADER_NOTE}`,
    '',
    pg.body.trim(),
    '',
  ].join('\n');
  return fm;
}

export function writePage(pg: WikiPage): void {
  mkdirSync(wikiDir(), { recursive: true });
  writeFileSync(pagePath(pg.slug), renderPage(pg), 'utf8');
}

// ---- [[wikilinks]] ----

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Extract the link targets ([[Title]] or [[slug]]) referenced in a page body. */
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const target = (m[1] || '').split('|')[0]!.trim();
    if (target) out.push(target);
  }
  return out;
}

// ---- routing (always local + free, via embeddings) ----

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

/** Below this cosine similarity a new fact starts its own page instead of merging. */
export const ROUTE_SIMILARITY_THRESHOLD = 0.55;

export interface RouteTarget {
  page: WikiPage;
  emb: number[]; // the page's representative embedding (title + body head)
}

/** Build a representative embedding per existing page for routing. */
export async function pageEmbeddings(pages: WikiPage[]): Promise<RouteTarget[]> {
  const out: RouteTarget[] = [];
  for (const page of pages) {
    const emb = await embed(`${page.title}\n${page.body.slice(0, 1500)}`);
    if (emb) out.push({ page, emb });
  }
  return out;
}

export interface RouteDecision {
  kind: 'existing' | 'new';
  slug: string; // target page slug (existing) or proposed slug (new)
  score: number; // similarity to the chosen page (0 for new)
}

/**
 * Route one fact to the nearest existing page by cosine similarity, or signal a
 * new page when nothing is close enough. When embeddings are unavailable (no
 * local Ollama), everything routes to a single "notes" page so sync still works.
 */
export async function routeFact(content: string, targets: RouteTarget[]): Promise<RouteDecision> {
  const e = await embed(content);
  if (!e) {
    // No embeddings: degrade to a single catch-all page (still correct, just coarse).
    return { kind: targets.length ? 'existing' : 'new', slug: targets[0]?.page.slug ?? 'notes', score: 0 };
  }
  let best: RouteTarget | null = null;
  let bestScore = -1;
  for (const t of targets) {
    const s = cosine(e, t.emb);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  if (best && bestScore >= ROUTE_SIMILARITY_THRESHOLD) {
    return { kind: 'existing', slug: best.page.slug, score: bestScore };
  }
  return { kind: 'new', slug: proposeSlug(content), score: bestScore < 0 ? 0 : bestScore };
}

/** Derive a short slug from a fact for a brand-new page. */
export function proposeSlug(content: string): string {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !ROUTE_STOPWORDS.has(w))
    .slice(0, 4);
  const slug = sanitizeName(words.join('-'));
  return slug || 'notes';
}

const ROUTE_STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'for', 'was', 'are', 'has',
  'have', 'will', 'user', 'their', 'they', 'about', 'into', 'per', 'via',
]);

// ---- maintainer abstraction ----

export type Maintainer =
  | { kind: 'cli'; id: BrainId; label: string }
  | { kind: 'api'; brain: ApiBrain; label: string }
  | { kind: 'local'; model: string; label: string };

export interface MaintainerReport {
  maintainer: Maintainer;
  /** True when a 'local' maintainer had to fall back to the brain. */
  fellBack: boolean;
  /** A human note about degradation, if any. */
  note?: string;
}

/**
 * Resolve which maintainer to use for this sync. For 'brain' we resolve the
 * folder's default brain exactly like the runner does. For 'local' we probe
 * Ollama for the generative model; if it is unreachable or not pulled we fall
 * back to the brain (with a clear note) rather than failing the whole sync.
 */
export async function resolveMaintainer(
  cfg: HoltConfig,
  resolveBrain: () => Maintainer | null,
): Promise<{ maintainer: Maintainer | null; report: MaintainerReport | null }> {
  if (cfg.wiki.maintainer === 'local') {
    const model = cfg.wiki.localModel;
    const status = await localModelStatus(model);
    if (status.reachable && status.hasModel) {
      const m: Maintainer = { kind: 'local', model, label: `local (${model})` };
      return { maintainer: m, report: { maintainer: m, fellBack: false } };
    }
    // Local not ready: build a clear note, then fall back to the brain if we can.
    const why = status.reachable
      ? `local model "${model}" is not pulled. Run: ${pullHint(model)}`
      : 'local Ollama is not reachable.';
    const brain = resolveBrain();
    if (brain) {
      return {
        maintainer: brain,
        report: { maintainer: brain, fellBack: true, note: `${why} Falling back to ${brain.label}.` },
      };
    }
    return { maintainer: null, report: null };
  }
  const brain = resolveBrain();
  if (!brain) return { maintainer: null, report: null };
  return { maintainer: brain, report: { maintainer: brain, fellBack: false } };
}

/** Run one maintenance prompt through whichever maintainer is active. */
export async function runMaintainer(
  m: Maintainer,
  cfg: HoltConfig,
  prompt: string,
): Promise<{ ok: boolean; text: string }> {
  if (m.kind === 'cli') return runBrain(cfg.brains[m.id], prompt);
  if (m.kind === 'api') return runApiBrain(m.brain, prompt);
  const r = await localGenerate(m.model, prompt);
  return { ok: r.ok, text: r.text };
}

// ---- prompts ----

/**
 * Prompt the maintainer to write or merge one page. We pass the existing body
 * (if any) plus the new facts and ask for concise synthesized prose ending in a
 * `## Related` section of [[links]]. Output is plain Markdown (no frontmatter):
 * the caller owns frontmatter + provenance.
 */
export function buildPagePrompt(
  title: string,
  existingBody: string,
  facts: string[],
  otherTitles: string[],
): string {
  const lines: string[] = [
    `You maintain a personal knowledge wiki. Write or update ONE page titled "${title}".`,
    'Output ONLY the page body in Markdown. No frontmatter, no code fences, no preamble.',
    '',
    'Rules:',
    '- Synthesize the facts into concise, self-contained prose (a few short paragraphs or tight bullets).',
    '- Merge new facts into the existing text; do not just append. Resolve overlaps. Keep it current.',
    '- Do not invent anything beyond the facts given.',
    '- End with a line "## Related" followed by [[Wiki Page]] links to other pages that connect.',
    '- Use [[double-bracket]] links for any other page you reference.',
  ];
  if (otherTitles.length) {
    lines.push('', 'Other existing pages you may link to:', ...otherTitles.map((t) => `- ${t}`));
  }
  if (existingBody.trim()) {
    lines.push('', 'Current page body:', existingBody.trim());
  }
  lines.push('', 'New facts to integrate:', ...facts.map((f) => `- ${f}`), '', 'Updated page body:');
  return lines.join('\n');
}

// ---- index.md (the MEMORY.md analog) ----

export function renderIndex(pages: WikiPage[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    '---',
    'title: Wiki Index',
    `updated: ${today}`,
    '---',
    '',
    '# Wiki',
    '',
    'Derived knowledge for this folder. Pages are synthesized from `facts.md` and',
    '`turns.jsonl` and are regenerable with `holt wiki rebuild`. Open in Obsidian to',
    'browse the [[links]].',
    '',
  ];
  if (pages.length === 0) {
    lines.push('_No pages yet. Run `holt wiki sync` after chatting._', '');
    return lines.join('\n');
  }
  lines.push('## Pages', '');
  for (const pg of [...pages].sort((a, b) => a.title.localeCompare(b.title))) {
    const when = pg.updated ? ` _(updated ${pg.updated})_` : '';
    lines.push(`- [[${pg.title}]]${when}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeIndex(pages: WikiPage[]): void {
  mkdirSync(wikiDir(), { recursive: true });
  writeFileSync(wikiIndexPath(), renderIndex(pages), 'utf8');
}

// ---- recall integration ----
//
// Wiki pages are high-value synthesized knowledge, so they should participate in
// recall(). The simplest correct approach that does NOT break existing memory
// stats or the graph: append a role:'fact' recall row tagged with a stable
// session 'wiki' and an id derived from the page slug, carrying the page title +
// body as content. recall() already surfaces role:'fact' rows and boosts them;
// memStats counts them as facts (documented). On rewrite we first drop the old
// wiki rows for that slug so we never accumulate stale duplicates.

export const WIKI_SESSION = 'wiki';

function wikiRowId(slug: string): string {
  // Stable, short, collision-safe within a folder: prefix + slug hash-ish.
  return 'wiki-' + sanitizeName(slug).slice(0, 24);
}

/** Rewrite turns.jsonl dropping any prior wiki recall row for these slugs. */
function dropWikiRows(slugs: Set<string>): MemTurn[] {
  const keep = loadTurns().filter((t) => !(t.session === WIKI_SESSION && slugs.has(t.id.replace(/^wiki-/, ''))));
  return keep;
}

/**
 * Refresh recall rows for the given pages: drop their old wiki rows, then append
 * fresh embedded rows. Rewrites turns.jsonl once. Never throws.
 */
export async function indexPagesForRecall(pages: WikiPage[]): Promise<void> {
  try {
    if (pages.length === 0) return;
    const slugs = new Set(pages.map((p) => sanitizeName(p.slug).slice(0, 24)));
    const kept = dropWikiRows(slugs);
    mkdirSync(join(wsHoltDir(), 'memory'), { recursive: true });
    writeFileSync(
      join(wsHoltDir(), 'memory', 'turns.jsonl'),
      kept.map((t) => JSON.stringify(t)).join('\n') + (kept.length ? '\n' : ''),
      'utf8',
    );
    for (const pg of pages) {
      const content = `${pg.title}\n${pg.body}`.slice(0, 4000);
      appendTurn({
        id: wikiRowId(pg.slug),
        ts: Date.now(),
        session: WIKI_SESSION,
        role: 'fact',
        content,
        emb: (await embed(content)) ?? undefined,
      });
    }
  } catch {
    // recall indexing is best-effort; a failure must not fail the sync
  }
}

/** Drop every wiki recall row (used by rebuild before regenerating). */
export function clearWikiRecallRows(): void {
  try {
    const kept = loadTurns().filter((t) => t.session !== WIKI_SESSION);
    mkdirSync(join(wsHoltDir(), 'memory'), { recursive: true });
    writeFileSync(
      join(wsHoltDir(), 'memory', 'turns.jsonl'),
      kept.map((t) => JSON.stringify(t)).join('\n') + (kept.length ? '\n' : ''),
      'utf8',
    );
  } catch {
    // best effort
  }
}

// ---- wipe (rebuild) ----

export function wipeWiki(): void {
  if (existsSync(wikiDir())) rmSync(wikiDir(), { recursive: true, force: true });
}

// ---- stats ----

export interface WikiStats {
  pages: number;
  bytes: number;
  lastSyncTs: number;
}

export function wikiStats(): WikiStats {
  const slugs = listPageSlugs();
  let bytes = 0;
  for (const slug of slugs) {
    try {
      bytes += statSync(pagePath(slug)).size;
    } catch {
      // ignore
    }
  }
  return { pages: slugs.length, bytes, lastSyncTs: loadState().lastSyncTs };
}

// ---- provenance helpers ----

export interface FactSource {
  id: string;
  content: string;
  ts: number;
}

/** Turns that are facts (role:'fact'), excluding the wiki recall rows. */
export function factRows(): FactSource[] {
  return loadTurns()
    .filter((t) => t.role === 'fact' && t.session !== WIKI_SESSION)
    .map((t) => ({ id: t.id, content: t.content, ts: t.ts }));
}

// ---- RAM-based local model recommendation ----
//
// One easily-editable table: total RAM (GiB) -> recommended local model. Bump
// these as models/quantizations change. Kept as a single const on purpose.

export interface RamRec {
  /** Inclusive lower bound of total RAM in GiB for this tier. */
  minGiB: number;
  model: string;
  note: string;
}

export const RAM_RECOMMENDATIONS: RamRec[] = [
  { minGiB: 48, model: 'qwen2.5:32b', note: 'plenty of headroom for a large local model (~20GB).' },
  { minGiB: 24, model: 'qwen2.5:14b', note: 'a 14B model (~9GB) fits comfortably.' },
  { minGiB: 16, model: 'qwen2.5:7b', note: 'default. ~4.7GB; tight alongside the embed model + editor. An always-on machine is a better host. Alternative: llama3.1:8b.' },
  { minGiB: 0, model: 'llama3.2:3b', note: 'under 16GB, local is discouraged; if you insist, this ~2GB model is modest quality. The brain maintainer is the better default.' },
];

export function totalGiB(): number {
  return Math.round((totalmem() / 1024 ** 3) * 10) / 10;
}

export interface Recommendation {
  gib: number;
  model: string;
  note: string;
  pull: string;
  discourageLocal: boolean;
}

/** Recommend a local model for the current machine's RAM. */
export function recommendLocalModel(gib: number = totalGiB()): Recommendation {
  const tier = RAM_RECOMMENDATIONS.find((r) => gib >= r.minGiB) ?? RAM_RECOMMENDATIONS[RAM_RECOMMENDATIONS.length - 1]!;
  return {
    gib,
    model: tier.model,
    note: tier.note,
    pull: pullHint(tier.model),
    discourageLocal: gib < 16,
  };
}

