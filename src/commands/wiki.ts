/**
 * `holt wiki`: the derived, LLM-maintained knowledge wiki (Layer 3 memory).
 *
 *   holt wiki                 status (maintainer, model, page count, last sync)
 *   holt wiki sync            fold new facts into pages (route + merge)
 *   holt wiki rebuild         wipe and regenerate every page from facts+turns
 *   holt wiki lint [--fix]    scan for contradictions/duplicates/gaps
 *   holt wiki list            list pages
 *   holt wiki show <page>     print a page
 *   holt wiki open            open the wiki (index.md) in the default app
 *   holt wiki setup           recommend a local model for this machine's RAM
 *
 * Gated by ensureTrusted like `holt memory`. Never throws on the write paths:
 * partial progress is fine, and the wiki is always regenerable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, BRAIN_IDS, findApiBrain, resolveApiKey, type BrainId, type HoltConfig } from '../config';
import { isInstalled } from '../brains';
import { ensureTrusted } from '../workspace';
import { c, createReader } from '../ui';
import { localModelStatus, pullHint } from '../localmodel';
import {
  wikiDir,
  wikiIndexPath,
  loadState,
  loadPages,
  listPageSlugs,
  readPage,
  writePage,
  writeIndex,
  wikiStats,
  factRows,
  pageEmbeddings,
  routeFact,
  proposeSlug,
  buildPagePrompt,
  resolveMaintainer,
  runMaintainer,
  indexPagesForRecall,
  clearWikiRecallRows,
  wipeWiki,
  recommendLocalModel,
  saveSyncMarker,
  type Maintainer,
  type WikiPage,
  type FactSource,
} from '../wiki';

/** Resolve the folder's default brain into a Maintainer (or null). Mirrors runner.ts. */
function resolveBrainMaintainer(cfg: HoltConfig): Maintainer | null {
  const id = cfg.defaultBrain;
  if (!id) return null;
  if ((BRAIN_IDS as string[]).includes(id)) {
    const b = cfg.brains[id as BrainId];
    if (!isInstalled(b.command)) return null;
    return { kind: 'cli', id: id as BrainId, label: b.label };
  }
  const api = findApiBrain(cfg, id);
  if (api && resolveApiKey(api)) return { kind: 'api', brain: api, label: `${id} (api: ${api.provider}/${api.model})` };
  return null;
}

/** Slugify a maintainer-proposed title back to a page slug (best effort). */
function titleToSlug(title: string): string {
  return proposeSlug(title);
}

interface SyncSummary {
  created: number;
  updated: number;
  factsIntegrated: number;
}

/**
 * Fold facts (given, already selected) into pages using the maintainer. Groups
 * facts by routed target page, one maintainer call per changed page. Returns a
 * summary. Never throws.
 */
async function foldFacts(
  cfg: HoltConfig,
  maintainer: Maintainer,
  facts: FactSource[],
): Promise<SyncSummary> {
  const summary: SyncSummary = { created: 0, updated: 0, factsIntegrated: 0 };
  if (facts.length === 0) return summary;

  let pages = loadPages();
  const targets = await pageEmbeddings(pages);

  // Route each fact to a target slug, grouping facts by page.
  const groups = new Map<string, { slug: string; isNew: boolean; facts: FactSource[] }>();
  for (const f of facts) {
    const decision = await routeFact(f.content, targets);
    let slug = decision.slug;
    let isNew = decision.kind === 'new';
    // If two new facts propose the same or an already-grouped slug, merge them.
    const existingGroup = groups.get(slug);
    if (existingGroup) {
      existingGroup.facts.push(f);
    } else {
      // A "new" slug that already exists on disk is really an update.
      if (isNew && listPageSlugs().includes(slug)) isNew = false;
      groups.set(slug, { slug, isNew, facts: [f] });
    }
  }

  // Track known titles so pages written later in this same sync can link back to
  // pages created earlier in it (otherwise the first-created pages get no links).
  const knownTitles = new Set(pages.map((p) => p.title));
  for (const group of groups.values()) {
    knownTitles.add(readPage(group.slug)?.title ?? deriveTitle(group.facts[0]!.content, group.slug));
  }
  const changed: WikiPage[] = [];

  for (const group of groups.values()) {
    const existing = readPage(group.slug);
    const title = existing?.title ?? deriveTitle(group.facts[0]!.content, group.slug);
    const prompt = buildPagePrompt(
      title,
      existing?.body ?? '',
      group.facts.map((f) => f.content),
      [...knownTitles].filter((t) => t !== title),
    );
    const res = await runMaintainer(maintainer, cfg, prompt);
    if (!res.ok || !res.text.trim()) {
      // Skip this page; do not lose progress on others.
      continue;
    }
    const body = stripFrontmatterEcho(res.text);
    const prevSources = existing?.sources ?? [];
    const page: WikiPage = {
      slug: group.slug,
      title,
      updated: new Date().toISOString().slice(0, 10),
      sources: dedupe([...prevSources, ...group.facts.map((f) => f.id)]),
      body,
    };
    writePage(page);
    changed.push(page);
    if (existing) summary.updated++;
    else summary.created++;
    summary.factsIntegrated += group.facts.length;
  }

  // Refresh index + recall for the pages that changed.
  pages = loadPages();
  writeIndex(pages);
  await indexPagesForRecall(changed);
  return summary;
}

function dedupe(a: string[]): string[] {
  return [...new Set(a)];
}

function deriveTitle(content: string, slug: string): string {
  // Human-friendly title from the slug (Title Case), fallback to first words.
  const fromSlug = slug.split('-').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
  return fromSlug || content.slice(0, 40);
}

/** Some models echo a frontmatter block despite instructions; strip a leading one. */
function stripFrontmatterEcho(text: string): string {
  let s = text.trim();
  s = s.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (s.startsWith('---')) {
    const end = s.indexOf('\n---', 3);
    if (end >= 0) s = s.slice(end + 4).trim();
  }
  return s;
}

// ---- subcommand: sync ----

async function syncCmd(cfg: HoltConfig): Promise<void> {
  const state = loadState();
  const all = factRows();
  const fresh = all.filter((f) => f.ts > state.lastSyncTs);
  if (fresh.length === 0) {
    console.log(c.dim('\n  No new facts since the last sync. Nothing to do.\n'));
    return;
  }

  const { maintainer, report } = await resolveMaintainer(cfg, () => resolveBrainMaintainer(cfg));
  if (!maintainer) {
    console.log(c.red('\n  No maintainer available.'));
    console.log(c.dim('  Configure a brain (holt init) or set wiki.maintainer to local with a pulled model.\n'));
    return;
  }
  if (report?.note) console.log(c.dim('\n  ' + report.note));

  console.log('\n' + c.dim(`  Integrating ${fresh.length} new fact${fresh.length === 1 ? '' : 's'} via ${maintainer.label}...`));
  const summary = await foldFacts(cfg, maintainer, fresh);

  // Advance the marker to the newest fact we saw (even if some pages were skipped;
  // rebuild is always available to recover, and re-syncing bad facts is fine).
  const newest = Math.max(state.lastSyncTs, ...fresh.map((f) => f.ts));
  saveSyncMarker(newest);

  console.log('\n' + c.accent('Wiki synced') + c.dim('  (this folder)'));
  console.log(`  facts integrated  ${summary.factsIntegrated}`);
  console.log(`  pages created     ${summary.created}`);
  console.log(`  pages updated     ${summary.updated}`);
  console.log(`  maintainer        ${maintainer.label}${report?.fellBack ? c.dim(' (fell back)') : ''}`);
  console.log(c.dim(`\n  Wiki: ${wikiDir()}  (open in Obsidian to browse [[links]])\n`));
}

// ---- subcommand: rebuild ----

async function rebuildCmd(cfg: HoltConfig, ask: (q: string) => Promise<string | null>): Promise<void> {
  const facts = factRows();
  if (facts.length === 0) {
    console.log(c.dim('\n  No facts to build from yet. Chat first so facts distill, then sync.\n'));
    return;
  }
  const a = ((await ask(`\n  Wipe and regenerate the wiki from ${facts.length} facts? This discards hand-edits. [y/N] `)) ?? '').trim().toLowerCase();
  if (a !== 'y' && a !== 'yes') {
    console.log(c.dim('  Kept.\n'));
    return;
  }

  const { maintainer, report } = await resolveMaintainer(cfg, () => resolveBrainMaintainer(cfg));
  if (!maintainer) {
    console.log(c.red('\n  No maintainer available. Configure a brain or a local model first.\n'));
    return;
  }
  if (report?.note) console.log(c.dim('  ' + report.note));

  wipeWiki();
  clearWikiRecallRows();
  console.log(c.dim(`\n  Rebuilding from ${facts.length} facts via ${maintainer.label}...`));
  const summary = await foldFacts(cfg, maintainer, facts);
  saveSyncMarker(Math.max(0, ...facts.map((f) => f.ts)));

  console.log('\n' + c.accent('Wiki rebuilt'));
  console.log(`  pages         ${summary.created}`);
  console.log(`  facts folded  ${summary.factsIntegrated}`);
  console.log(c.dim(`\n  Wiki: ${wikiDir()}\n`));
}

// ---- subcommand: lint ----

function buildLintPrompt(pages: WikiPage[]): string {
  const lines: string[] = [
    'You are auditing a personal knowledge wiki for quality. Review the pages below.',
    'Report, concisely and as plain text (no code fences):',
    '- CONTRADICTIONS: statements across pages that conflict.',
    '- DUPLICATES: pages or passages that overlap and should merge.',
    '- GAPS: obvious missing links ([[...]]) or topics implied but not written.',
    'If a category is clean, say so in one line. Do not rewrite the pages.',
    '',
    'Pages:',
  ];
  for (const pg of pages) {
    lines.push('', `### ${pg.title} (${pg.slug})`, pg.body.slice(0, 1200));
  }
  return lines.join('\n');
}

async function lintCmd(cfg: HoltConfig, fix: boolean): Promise<void> {
  const pages = loadPages();
  if (pages.length === 0) {
    console.log(c.dim('\n  No pages to lint. Run "holt wiki sync" first.\n'));
    return;
  }
  const { maintainer, report } = await resolveMaintainer(cfg, () => resolveBrainMaintainer(cfg));
  if (!maintainer) {
    console.log(c.red('\n  No maintainer available. Configure a brain or a local model first.\n'));
    return;
  }
  if (report?.note) console.log(c.dim('\n  ' + report.note));

  if (fix) {
    console.log(c.dim('\n  Note: --fix can rewrite pages. Put .holt/wiki under git or back it up first.'));
    console.log(c.dim('  For now, lint proposes only; applying edits is left to a future release. Showing the report.\n'));
  }

  console.log(c.dim(`\n  Auditing ${pages.length} page${pages.length === 1 ? '' : 's'} via ${maintainer.label}...\n`));
  const res = await runMaintainer(maintainer, cfg, buildLintPrompt(pages));
  if (!res.ok || !res.text.trim()) {
    console.log(c.dim('  Lint could not produce a report (maintainer returned nothing).\n'));
    return;
  }
  console.log(res.text.trim() + '\n');
}

// ---- subcommand: list / show / status / open / setup ----

function listCmd(): void {
  const slugs = listPageSlugs();
  if (slugs.length === 0) {
    console.log(c.dim('\n  No wiki pages yet. Run "holt wiki sync" after chatting.\n'));
    return;
  }
  console.log('\n' + c.accent('Wiki pages') + c.dim('  (this folder)'));
  for (const slug of slugs) {
    const pg = readPage(slug);
    if (!pg) continue;
    const size = existsSync(join(wikiDir(), slug + '.md')) ? (readFileSync(join(wikiDir(), slug + '.md'), 'utf8').length / 1024).toFixed(1) : '0.0';
    console.log(`  ${c.cyan(pg.title.padEnd(28).slice(0, 28))} ${c.dim(pg.updated || '          ')}  ${size} KB`);
  }
  console.log('');
}

function showCmd(name: string): void {
  if (!name) {
    console.log(c.dim('\n  Usage: holt wiki show <page>\n'));
    return;
  }
  // Match by slug or title (case-insensitive).
  const want = name.toLowerCase();
  const slug = listPageSlugs().find((s) => s.toLowerCase() === want || s.toLowerCase() === titleToSlug(name))
    ?? loadPages().find((p) => p.title.toLowerCase() === want)?.slug;
  if (!slug) {
    console.log(c.dim(`\n  No page "${name}". Try "holt wiki list".\n`));
    return;
  }
  const raw = readFileSync(join(wikiDir(), slug + '.md'), 'utf8');
  console.log('\n' + raw.trim() + '\n');
}

async function statusCmd(cfg: HoltConfig): Promise<void> {
  const stats = wikiStats();
  const rec = recommendLocalModel();
  const state = loadState();
  const lastSync = state.lastSyncTs ? new Date(state.lastSyncTs).toISOString().slice(0, 10) : 'never';

  console.log('\n' + c.accent('Holt wiki') + c.dim('  (this folder)'));
  console.log(`  maintainer    ${cfg.wiki.maintainer}`);
  console.log(`  localModel    ${cfg.wiki.localModel}`);
  console.log(`  pages         ${stats.pages}`);
  console.log(`  size          ${(stats.bytes / 1024).toFixed(1)} KB  (./.holt/wiki/)`);
  console.log(`  last sync     ${lastSync}`);

  if (cfg.wiki.maintainer === 'local') {
    const st = await localModelStatus(cfg.wiki.localModel);
    const line = st.reachable
      ? st.hasModel
        ? c.green('ready')
        : c.red('model not pulled') + c.dim(`  (${pullHint(cfg.wiki.localModel)})`)
      : c.red('Ollama not reachable');
    console.log(`  local status  ${line}`);
  }

  console.log(c.dim(`\n  RAM ${rec.gib} GiB -> recommended local model: ${rec.model}`));
  console.log(c.dim(`  ${rec.note}`));
  if (rec.discourageLocal) console.log(c.dim('  Local maintenance is discouraged at this RAM; the brain maintainer is recommended.'));
  console.log(c.dim(`  Pull it with: ${rec.pull}`));

  console.log(c.dim('\n  holt wiki sync              fold new facts into pages'));
  console.log(c.dim('  holt wiki rebuild           regenerate the whole wiki from facts'));
  console.log(c.dim('  holt wiki lint              audit for contradictions, duplicates, gaps'));
  console.log(c.dim('  holt wiki list / show <p>   browse pages'));
  console.log(c.dim('  holt wiki open              open in your default app (Obsidian reads it natively)\n'));
}

function setupCmd(cfg: HoltConfig): void {
  const rec = recommendLocalModel();
  console.log('\n' + c.accent('Local wiki maintainer: model recommendation'));
  console.log(`  detected RAM   ${rec.gib} GiB`);
  console.log(`  recommended    ${c.cyan(rec.model)}`);
  console.log(`  why            ${rec.note}`);
  if (rec.discourageLocal) {
    console.log(c.dim('\n  At under 16 GiB, keep wiki.maintainer = brain (rides your Claude plan, no marginal RAM).'));
  }
  console.log(c.dim(`\n  To use it locally:`));
  console.log(c.dim(`    1. ${rec.pull}`));
  console.log(c.dim(`    2. set wiki.maintainer = "local" and wiki.localModel = "${rec.model}" in .holt/config.json`));
  console.log(c.dim(`  Current: maintainer=${cfg.wiki.maintainer}, localModel=${cfg.wiki.localModel}\n`));
}

function openCmd(): void {
  const target = existsSync(wikiIndexPath()) ? wikiIndexPath() : wikiDir();
  if (!existsSync(target)) {
    console.log(c.dim('\n  No wiki yet. Run "holt wiki sync" first.\n'));
    return;
  }
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === 'darwin') { cmd = 'open'; args = [target]; }
    else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', target]; }
    else { cmd = 'xdg-open'; args = [target]; }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    console.log(c.dim(`\n  Opening ${target}`));
    console.log(c.dim('  Tip: Obsidian can open .holt/wiki as a vault and read the [[links]] natively.\n'));
  } catch {
    console.log(c.dim(`\n  Could not open it. Path: ${target}\n`));
  }
}

// ---- dispatch ----

export async function wikiCmd(sub?: string, rest: string[] = []): Promise<void> {
  const action = (sub || '').toLowerCase();

  // Pure reads still follow the memory command's trust pattern (gate everything).
  const { ask, close } = createReader();
  if (!(await ensureTrusted(ask))) { close(); return; }

  const cfg = loadConfig();
  if (!cfg) {
    console.log(c.dim('\n  No Holt setup in this folder. Run "holt init" first.\n'));
    close();
    return;
  }

  try {
    switch (action) {
      case 'sync':
        await syncCmd(cfg);
        break;
      case 'rebuild':
        await rebuildCmd(cfg, ask);
        break;
      case 'lint':
        await lintCmd(cfg, rest.includes('--fix'));
        break;
      case 'list':
        listCmd();
        break;
      case 'show':
        showCmd(rest.join(' ').trim());
        break;
      case 'open':
        openCmd();
        break;
      case 'setup':
      case 'recommend':
        setupCmd(cfg);
        break;
      case '':
      case 'status':
        await statusCmd(cfg);
        break;
      default:
        console.error(`\n  Unknown wiki subcommand: "${sub}". Use: sync | rebuild | lint | list | show <page> | open | status | setup\n`);
        process.exitCode = 1;
    }
  } finally {
    close();
  }
}
