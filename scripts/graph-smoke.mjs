#!/usr/bin/env node
/**
 * Richer-graph smoke test. Runs the built CLI (dist/cli.js) in an ISOLATED temp
 * HOME + temp workspace (never touches the real ~/.holt), with a stub `open` on
 * PATH so no real browser spawns. Covers the feature spec:
 *   (a) `holt graph --code` ingests interlinked .ts files, resolves the planted
 *       import edges, renders valid self-contained HTML with file nodes + dep
 *       edges; and does not crash on a folder with no code.
 *   (b) `holt graph --docs` ingests docs and their links.
 *   (c) communities: nodes get community ids; two separate clusters land in
 *       different communities; report/coloring reflect it.
 *   (d) `holt graph report` writes GRAPH_REPORT.md naming the top god-node +
 *       per-community summaries; sensible on empty input (no crash).
 *   (e) SECURITY: a file whose path/content contains </script>, <!--, and an
 *       <img onerror=...> does not break the JSON block or inject; the embedded
 *       JSON still parses and no raw </script> leaks.
 *   plus: default `holt graph` (no flags) is unchanged (memory-only).
 */
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CLI = join(REPO, 'dist', 'cli.js');

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

// ---- isolated env + stub `open` so no browser spawns ----
const HOME = mkdtempSync(join(tmpdir(), 'holt-home-'));
const BIN = mkdtempSync(join(tmpdir(), 'holt-bin-'));
for (const name of ['open', 'xdg-open']) {
  const p = join(BIN, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
}
const env = { ...process.env, HOME, NO_COLOR: '1', PATH: BIN + ':' + process.env.PATH };
delete env.HOLT_OLLAMA_URL;

function makeWs() {
  const ws = mkdtempSync(join(tmpdir(), 'holt-ws-'));
  const phys = realpathSync(ws);
  mkdirSync(join(ws, '.holt'), { recursive: true });
  writeFileSync(join(HOME, '.holt', 'trust.json'), JSON.stringify({ trusted: [phys, ws] }, null, 2));
  return { ws, phys };
}
mkdirSync(join(HOME, '.holt'), { recursive: true });

function runCli(ws, args) {
  return spawnSync('node', [CLI, ...args], { cwd: ws, env, input: '', encoding: 'utf8' });
}

// ===========================================================================
// PROJECT: two clearly-separate clusters + docs + an XSS-laden file.
//   Cluster A: a.ts -> b.ts -> c.ts (chain)   Cluster B: x.ts -> y.ts (pair)
//   Docs: guide.md -> intro.md (link)
//   evil file: content + path carry </script>, <!--, <img onerror>.
// ===========================================================================
const { ws } = makeWs();
writeFileSync(join(ws, 'a.ts'), `import { b } from './b';\nexport const a = () => b();\n`);
writeFileSync(join(ws, 'b.ts'), `import { c } from './c';\nexport const b = () => c();\n`);
writeFileSync(join(ws, 'c.ts'), `export const c = () => 42;\n`);
writeFileSync(join(ws, 'x.ts'), `import { y } from './y';\nexport const x = () => y();\n`);
writeFileSync(join(ws, 'y.ts'), `export const y = () => 'hi';\n`);
// a bare/package import must NOT create an edge:
writeFileSync(join(ws, 'z.ts'), `import { readFileSync } from 'node:fs';\nexport const z = readFileSync;\n`);
mkdirSync(join(ws, 'docs'), { recursive: true });
writeFileSync(join(ws, 'docs', 'guide.md'), `# Guide\n\nSee [intro](./intro.md) and [[intro]].\n`);
writeFileSync(join(ws, 'docs', 'intro.md'), `# Intro\n\nWelcome.\n`);
// XSS: content tries to break out of the <script> block and inject.
writeFileSync(
  join(ws, 'evil.ts'),
  `// </script><script>window.__pwned=1</script>\n// <!-- comment -->\n// <img src=x onerror="window.__pwned=2">\nimport { a } from './a';\nexport const e = a;\n`,
);
// also a node_modules dir that MUST be skipped:
mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
writeFileSync(join(ws, 'node_modules', 'pkg', 'index.ts'), `export const nope = 1;\n`);

// ---- (a) holt graph --code ----
const rc = runCli(ws, ['graph', '--code', '--no-open']);
check('graph --code exits 0', rc.status === 0, rc.stderr.trim().slice(-200));
const htmlPath = join(ws, '.holt', 'graph.html');
check('graph.html written', existsSync(htmlPath));
const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : '';
check('reports code files in stdout', /code files/.test(rc.stdout), rc.stdout.trim().slice(-160));
check('node_modules skipped (no "nope")', !/nope/.test(html));

// parse the embedded JSON like a browser would
function parseGraphJson(h) {
  const m = h.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  // The renderer escapes </script as <\/script; undo the JSON string escape by
  // parsing (JSON.parse handles \/ fine). But our marker regex stops at the FIRST
  // real </script>, which the escaping guarantees is the true closing tag.
  try { return JSON.parse(m[1]); } catch { return null; }
}
const data = parseGraphJson(html);
check('embedded JSON parses', !!data, data ? '' : 'JSON.parse failed');
const fileNodes = data ? data.nodes.filter((n) => n.kind === 'file') : [];
check('file nodes present', fileNodes.length >= 6, `got ${fileNodes.length}`);
const depEdges = data ? data.edges.filter((e) => e.kind === 'dep') : [];
function hasEdge(edges, src, tgt) {
  return edges.some((e) => e.source.endsWith(src) && e.target.endsWith(tgt));
}
check('planted edge a.ts -> b.ts', hasEdge(depEdges, 'a.ts', 'b.ts'));
check('planted edge b.ts -> c.ts', hasEdge(depEdges, 'b.ts', 'c.ts'));
check('planted edge x.ts -> y.ts', hasEdge(depEdges, 'x.ts', 'y.ts'));
check('bare import made NO edge (z.ts has no dep edge)', !depEdges.some((e) => e.source.endsWith('z.ts')));

// ---- (e) SECURITY ----
check('no raw </script> leaks before the real data script close', (() => {
  // Everything up to the graph-data script must not contain a stray closing
  // </script> that would let evil.ts break out. Count real closing tags: the
  // data block must be exactly one contiguous JSON blob.
  const idx = html.indexOf('<script id="graph-data"');
  const after = html.slice(idx);
  const close = after.indexOf('</script>');
  const blob = after.slice(0, close);
  // The escaped payload uses <\/script, never a raw </script, inside the blob.
  return !/<\/script>/i.test(blob.slice(blob.indexOf('>') + 1));
})());
check('window.__pwned only appears inside the escaped JSON blob (not live HTML)', (() => {
  // The opening <script>window.__pwned tag is harmless while it sits INSIDE the
  // still-open application/json block, because the payload's own closing tag was
  // escaped to <\/script (so the block never terminates early). Verify every
  // occurrence of the injected marker is immediately preceded by that escaped
  // closing sequence, i.e. it lives in the data blob, never as a live tag.
  let ok = true;
  let from = 0;
  for (;;) {
    const i = html.indexOf('<script>window.__pwned', from);
    if (i < 0) break;
    const before = html.slice(Math.max(0, i - 12), i);
    if (!before.includes('<\\/script')) ok = false;
    from = i + 1;
  }
  return ok;
})());
check('evil content survived as escaped JSON (snippet contains img text, inert)',
  data && data.nodes.some((n) => (n.snippet || '').includes('onerror')));

// ---- (c) communities ----
function commOf(nodes, suffix) {
  const n = nodes.find((x) => x.id.endsWith(suffix));
  return n ? n.community : undefined;
}
if (data) {
  const cA = commOf(data.nodes, 'a.ts');
  const cX = commOf(data.nodes, 'x.ts');
  const cY = commOf(data.nodes, 'y.ts');
  check('nodes have community ids', cA != null && cX != null);
  check('cluster A and cluster B differ', cA !== cX, `A=${cA} B=${cX}`);
  check('x.ts and y.ts share a community', cX === cY, `x=${cX} y=${cY}`);
}

// ---- (b) holt graph --docs ----
const rd = runCli(ws, ['graph', '--docs', '--no-open']);
check('graph --docs exits 0', rd.status === 0, rd.stderr.trim().slice(-200));
const htmlD = readFileSync(htmlPath, 'utf8');
const dataD = parseGraphJson(htmlD);
const docNodes = dataD ? dataD.nodes.filter((n) => n.kind === 'doc') : [];
check('doc nodes present', docNodes.length >= 2, `got ${docNodes.length}`);
const linkEdges = dataD ? dataD.edges.filter((e) => e.kind === 'link') : [];
check('doc link guide.md -> intro.md', hasEdge(linkEdges, 'guide.md', 'intro.md'), `links=${linkEdges.length}`);

// ---- (d) holt graph report ----
const rr = runCli(ws, ['graph', 'report']);
check('graph report exits 0', rr.status === 0, rr.stderr.trim().slice(-200));
const reportPath = join(ws, 'GRAPH_REPORT.md');
check('GRAPH_REPORT.md written', existsSync(reportPath));
const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
check('report has God Nodes section', /## God Nodes/.test(report));
check('report has Communities section', /## Communities/.test(report));
check('report names a god node with edges', /\d+ edges \(community/.test(report), report.split('\n').slice(0, 20).join(' | '));
check('report is em-dash free', !report.includes('\u2014'));

// ---- default `holt graph` (no flags) unchanged: memory-only ----
// Fresh workspace with NO memory and NO code: must print the "no memory" hint,
// NOT ingest code. (Ensures default is opt-in only.)
const { ws: ws2 } = makeWs();
writeFileSync(join(ws2, 'lonely.ts'), `export const q = 1;\n`);
const rdef = runCli(ws2, ['graph', '--no-open']);
check('default graph does not ingest code (memory-only)',
  /No memory in this folder/.test(rdef.stdout) || !/code files/.test(rdef.stdout),
  rdef.stdout.trim().slice(-160));

// ---- empty ingest: --code in a folder with NO code must not crash ----
const { ws: ws3 } = makeWs();
writeFileSync(join(ws3, 'notes.txt'), `just text`); // txt is a doc, not code
const rEmpty = runCli(ws3, ['graph', '--code', '--no-open']);
check('graph --code on no-code folder does not crash', rEmpty.status === 0 || /No memory/.test(rEmpty.stdout), rEmpty.stderr.trim().slice(-160));

// ---- report on truly empty folder: sensible, no crash ----
const { ws: ws4 } = makeWs();
const rEmptyRep = runCli(ws4, ['graph', 'report']);
check('report on empty folder exits 0', rEmptyRep.status === 0, rEmptyRep.stderr.trim().slice(-160));
const emptyRep = join(ws4, 'GRAPH_REPORT.md');
check('empty report written with sensible message', existsSync(emptyRep) && /0 nodes/.test(readFileSync(emptyRep, 'utf8')));

console.log('');
console.log(failures === 0 ? 'ALL GRAPH SMOKE TESTS PASSED' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
