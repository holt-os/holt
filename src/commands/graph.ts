/**
 * `holt graph`: the headline feature. Render this folder's memory as an
 * interactive knowledge graph you can walk, and open it in the browser.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadTurns } from '../memory';
import { ensureTrusted, wsHoltDir, workspace } from '../workspace';
import { buildGraph, buildWikiGraph, mergeGraphs, renderGraphHtml, type WikiGraphPage } from '../graphview';
import { wikiDir, loadPages, extractLinks } from '../wiki';
import { c, createReader } from '../ui';

interface Opts {
  out?: string;
  open: boolean;
  wiki?: boolean; // undefined = auto (include when .holt/wiki exists)
}

function parseArgs(args: string[]): Opts {
  const opts: Opts = { open: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-open') opts.open = false;
    else if (a === '--wiki') opts.wiki = true;
    else if (a === '--no-wiki') opts.wiki = false;
    else if (a === '--out') opts.out = args[++i];
    else if (a && a.startsWith('--out=')) opts.out = a.slice('--out='.length);
  }
  return opts;
}

/** Wiki pages as graph-ready records: title, slug, and resolved outgoing links. */
function wikiGraphPages(): WikiGraphPage[] {
  return loadPages().map((p) => ({ slug: p.slug, title: p.title, links: extractLinks(p.body) }));
}

/** Open a file in the OS default browser, detached; failures are swallowed. */
function openInBrowser(path: string): void {
  try {
    let cmd: string;
    let cmdArgs: string[];
    if (process.platform === 'darwin') { cmd = 'open'; cmdArgs = [path]; }
    else if (process.platform === 'win32') { cmd = 'cmd'; cmdArgs = ['/c', 'start', '', path]; }
    else { cmd = 'xdg-open'; cmdArgs = [path]; }
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // never let opening a browser break the command
  }
}

/** `holt graph [--out <path>] [--no-open]` */
export async function graph(args: string[] = []): Promise<void> {
  const { ask, close } = createReader();
  if (!(await ensureTrusted(ask))) { close(); return; }
  close();

  const opts = parseArgs(args);
  const turns = loadTurns();

  // Auto-include the wiki when it exists, unless the flag forces it on/off.
  const includeWiki = opts.wiki !== undefined ? opts.wiki : existsSync(wikiDir());
  const wikiPages = includeWiki ? wikiGraphPages() : [];

  if (turns.length === 0 && wikiPages.length === 0) {
    console.log(c.dim('\n  No memory in this folder yet. Have a chat first with "holt chat", then come back.\n'));
    return;
  }

  let g = buildGraph(turns);
  if (wikiPages.length) g = mergeGraphs(g, buildWikiGraph(wikiPages));

  const conceptCount = g.nodes.filter((n) => n.kind === 'concept').length;
  const wikiCount = g.nodes.filter((n) => n.kind === 'wiki').length;
  const sessions = new Set(turns.map((t) => t.session)).size;

  const html = renderGraphHtml(g, {
    workspace: workspace(),
    turns: turns.length,
    sessions,
    concepts: conceptCount,
    edges: g.edges.length,
  });

  const outPath = opts.out ? resolve(opts.out) : join(wsHoltDir(), 'graph.html');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf8');

  console.log('\n' + c.accent('Memory graph built') + c.dim('  (this folder)'));
  const parts = [`${turns.length} turns`, `${conceptCount} concepts`];
  if (wikiCount) parts.push(`${wikiCount} wiki pages`);
  console.log(`  nodes    ${g.nodes.length}  (${parts.join(', ')})`);
  console.log(`  edges    ${g.edges.length}`);
  console.log(`  file     ${outPath}`);

  if (opts.open) {
    openInBrowser(outPath);
    console.log(c.dim('\n  Opening in your browser...\n'));
  } else {
    console.log(c.dim('\n  Open it in any browser to explore.\n'));
  }
}
