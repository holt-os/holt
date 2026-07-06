/**
 * `holt wiki`: the derived, LLM-maintained knowledge wiki (Layer 3 memory).
 *
 *   holt wiki                 status (maintainer, model, auto-sync, page count, last sync)
 *   holt wiki sync            fold new facts into pages (route + merge)
 *   holt wiki auto [on|off]   toggle auto-sync at session end (wiki.autoSync)
 *   holt wiki rebuild         wipe and regenerate every page from facts+turns
 *   holt wiki lint [--fix]    scan for contradictions/duplicates/gaps; --fix applies them
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
import { loadConfig, saveConfig, type HoltConfig } from '../config';
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
  wikiStats,
  factRows,
  proposeSlug,
  resolveMaintainer,
  runMaintainer,
  clearWikiRecallRows,
  wipeWiki,
  recommendLocalModel,
  saveSyncMarker,
  syncWiki,
  foldFacts,
  resolveBrainMaintainer,
  type WikiPage,
} from '../wiki';

/** Slugify a maintainer-proposed title back to a page slug (best effort). */
function titleToSlug(title: string): string {
  return proposeSlug(title);
}

// ---- subcommand: sync ----
//
// The heavy lifting (select fresh facts, resolve a maintainer, fold, advance the
// marker) lives in wiki.ts's syncWiki() so the auto-sync triggers share it. This
// command just renders the result; its output is byte-for-byte what it was.

async function syncCmd(cfg: HoltConfig): Promise<void> {
  const res = await syncWiki(cfg, () => resolveBrainMaintainer(cfg));

  if (res.status === 'nothing') {
    console.log(c.dim('\n  No new facts since the last sync. Nothing to do.\n'));
    return;
  }
  if (res.status === 'no-maintainer') {
    if (res.report?.note) console.log(c.dim('\n  ' + res.report.note));
    console.log(c.red('\n  No maintainer available.'));
    console.log(c.dim('  Configure a brain (holt init) or set wiki.maintainer to local with a pulled model.\n'));
    return;
  }

  const maintainer = res.maintainer!;
  if (res.report?.note) console.log(c.dim('\n  ' + res.report.note));

  console.log('\n' + c.dim(`  Integrated ${res.freshFacts} new fact${res.freshFacts === 1 ? '' : 's'} via ${maintainer.label}...`));

  console.log('\n' + c.accent('Wiki synced') + c.dim('  (this folder)'));
  console.log(`  facts integrated  ${res.factsIntegrated}`);
  console.log(`  pages created     ${res.created}`);
  console.log(`  pages updated     ${res.updated}`);
  console.log(`  maintainer        ${maintainer.label}${res.report?.fellBack ? c.dim(' (fell back)') : ''}`);
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
  const { summary } = await foldFacts(cfg, maintainer, facts);
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

/**
 * The fix prompt asks the maintainer to RETURN corrected page bodies. Each page
 * is emitted between explicit markers so we can parse per-page bodies back out
 * and rewrite only the pages that actually changed. A page with no needed change
 * should be echoed unchanged (we diff and skip no-ops).
 */
const FIX_BEGIN = '<<<HOLT-PAGE ';
const FIX_END = '<<<HOLT-END>>>';

function buildFixPrompt(pages: WikiPage[]): string {
  const lines: string[] = [
    'You maintain a personal knowledge wiki. Fix quality issues across the pages',
    'below: resolve CONTRADICTIONS (keep the most recent/consistent statement),',
    'merge DUPLICATE passages, and add obvious missing [[wikilinks]]. Do not invent',
    'new facts; only reconcile and de-duplicate what is already written.',
    '',
    'Return EVERY page, even unchanged ones, using EXACTLY this format and nothing',
    'else (no prose, no code fences, no frontmatter):',
    '',
    `${FIX_BEGIN}<slug>>>>`,
    '<corrected page body in Markdown, ending with a "## Related" section of [[links]]>',
    FIX_END,
    '',
    'Pages:',
  ];
  for (const pg of pages) {
    lines.push('', `${FIX_BEGIN}${pg.slug}>>>`, `### ${pg.title}`, pg.body.trim(), FIX_END);
  }
  return lines.join('\n');
}

/** Parse the fix reply into a map of slug -> corrected body. Never throws. */
function parseFixReply(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = raw || '';
  let i = 0;
  while (true) {
    const begin = text.indexOf(FIX_BEGIN, i);
    if (begin < 0) break;
    const slugStart = begin + FIX_BEGIN.length;
    const slugEnd = text.indexOf('>>>', slugStart);
    if (slugEnd < 0) break;
    const slug = text.slice(slugStart, slugEnd).trim();
    const bodyStart = slugEnd + 3;
    const end = text.indexOf(FIX_END, bodyStart);
    if (end < 0) break;
    let body = text.slice(bodyStart, end).trim();
    // Strip a leading "### Title" echo line; the title comes from frontmatter.
    body = body.replace(/^###[^\n]*\n+/, '').trim();
    if (slug && body) out.set(slug, body);
    i = end + FIX_END.length;
  }
  return out;
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

  // Default path (no --fix): audit and print a report only. Files untouched.
  if (!fix) {
    console.log(c.dim(`\n  Auditing ${pages.length} page${pages.length === 1 ? '' : 's'} via ${maintainer.label}...\n`));
    const res = await runMaintainer(maintainer, cfg, buildLintPrompt(pages));
    if (!res.ok || !res.text.trim()) {
      console.log(c.dim('  Lint could not produce a report (maintainer returned nothing).\n'));
      return;
    }
    console.log(res.text.trim() + '\n');
    return;
  }

  // --fix path: ask for corrected bodies and APPLY them. Pages are derived and
  // regenerable ("holt wiki rebuild"), so applying is safe, but still nudge the
  // user toward git/backup before we rewrite files.
  console.log(c.dim('\n  --fix will rewrite affected pages. Put .holt/wiki under git or back it up first;'));
  console.log(c.dim('  a bad fix is fully recoverable with "holt wiki rebuild".'));
  console.log(c.dim(`\n  Auditing + fixing ${pages.length} page${pages.length === 1 ? '' : 's'} via ${maintainer.label}...\n`));

  const res = await runMaintainer(maintainer, cfg, buildFixPrompt(pages));
  if (!res.ok || !res.text.trim()) {
    console.log(c.dim('  Lint --fix could not produce corrections (maintainer returned nothing). Files untouched.\n'));
    return;
  }

  const corrected = parseFixReply(res.text);
  if (corrected.size === 0) {
    console.log(c.dim('  No parseable corrections returned. Files untouched.\n'));
    return;
  }

  const byPage = new Map(pages.map((p) => [p.slug, p]));
  const applied: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const [slug, body] of corrected) {
    const page = byPage.get(slug);
    if (!page) continue; // maintainer named a page we do not have; ignore safely
    if (body.trim() === page.body.trim()) continue; // no-op; skip
    try {
      // Preserve provenance (sources) and title; only the body + updated date change.
      writePage({ ...page, body: body.trim(), updated: today });
      applied.push(page.title);
    } catch {
      // partial application is fine; keep going
    }
  }

  if (applied.length === 0) {
    console.log(c.dim('  Lint found nothing to change. Pages already clean.\n'));
    return;
  }
  console.log('\n' + c.accent('Wiki lint applied') + c.dim('  (this folder)'));
  console.log(`  pages rewritten   ${applied.length}`);
  for (const t of applied) console.log(c.dim(`    - ${t}`));
  console.log(c.dim(`\n  Recover any page with "holt wiki rebuild". Wiki: ${wikiDir()}\n`));
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
  console.log(`  auto-sync     ${cfg.wiki.autoSync ? c.green('on') : c.dim('off')}${cfg.wiki.autoSync ? '' : c.dim('  (holt wiki auto on)')}`);
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
  console.log(c.dim('  holt wiki auto [on|off]     auto-sync the wiki when a session ends'));
  console.log(c.dim('  holt wiki rebuild           regenerate the whole wiki from facts'));
  console.log(c.dim('  holt wiki lint [--fix]      audit (and with --fix, apply) contradiction/duplicate fixes'));
  console.log(c.dim('  holt wiki list / show <p>   browse pages'));
  console.log(c.dim('  holt wiki open              open in your default app (Obsidian reads it natively)\n'));
}

/**
 * `holt wiki auto [on|off]`: toggle wiki.autoSync in the folder config. With no
 * argument it reports the current state. When on, the wiki syncs automatically
 * at the end of a `holt chat` session and when the Claude Code Stop hook fires.
 */
function autoCmd(cfg: HoltConfig, arg: string): void {
  const want = (arg || '').toLowerCase();
  if (want === '') {
    const on = cfg.wiki.autoSync === true;
    console.log('\n' + c.accent('Wiki auto-sync') + c.dim('  (this folder)'));
    console.log(`  ${on ? c.green('on') : c.dim('off')}`);
    console.log(c.dim('  usage: holt wiki auto on | off'));
    console.log(c.dim('  When on, the wiki folds new facts in automatically after a chat session'));
    console.log(c.dim('  or when the Claude Code Stop hook captures facts. No manual "holt wiki sync".\n'));
    return;
  }
  if (want !== 'on' && want !== 'off') {
    console.log(c.dim('\n  usage: holt wiki auto on | off\n'));
    return;
  }
  cfg.wiki.autoSync = want === 'on';
  saveConfig(cfg);
  console.log(
    want === 'on'
      ? c.green('\n  wiki auto-sync: on') + c.dim('  (syncs at session end)\n')
      : c.dim('\n  wiki auto-sync: off\n'),
  );
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
      case 'auto':
        autoCmd(cfg, rest[0] ?? '');
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
        console.error(`\n  Unknown wiki subcommand: "${sub}". Use: sync | auto | rebuild | lint | list | show <page> | open | status | setup\n`);
        process.exitCode = 1;
    }
  } finally {
    close();
  }
}
