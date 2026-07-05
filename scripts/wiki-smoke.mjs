#!/usr/bin/env node
/**
 * Wiki smoke test. Runs the built CLI (dist/cli.js) in an ISOLATED temp HOME and
 * temp workspace so it never touches the real ~/.holt. Uses a fake brain. Covers:
 *   (a) sync creates pages + index + provenance + [[links]]; second sync routes
 *       new facts into existing pages (no dup pages for near-duplicate facts).
 *   (b) rebuild regenerates from facts.
 *   (c) list / show / status.
 *   (d) maintainer:'local' with a dead Ollama port degrades gracefully.
 *   (e) graph --wiki renders without crashing (empty + populated); valid HTML.
 *   plus: config migration v4 -> v5 loads an old config with no data loss, and
 *   existing `holt memory` / `holt graph` still work.
 */
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CLI = join(REPO, 'dist', 'cli.js');
const FAKE_BRAIN = join(REPO, 'scripts', 'fake-brain.mjs');

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

// ---- isolated environment ----
const HOME = mkdtempSync(join(tmpdir(), 'holt-home-'));
const WS = mkdtempSync(join(tmpdir(), 'holt-ws-'));
// The CLI trusts process.cwd(), which Node returns as the resolved (physical)
// path. macOS /tmp and /var symlink through /private, so store the realpath.
const WS_PHYS = realpathSync(WS);

const env = { ...process.env, HOME, NO_COLOR: '1' };
delete env.HOLT_OLLAMA_URL; // use the real local Ollama for embeddings/routing

function runCli(args, opts = {}) {
  return spawnSync('node', [CLI, ...args], {
    cwd: WS,
    env: opts.env || env,
    input: opts.input ?? '',
    encoding: 'utf8',
  });
}

// ---- seed: trust file (physical path), config (v5), facts ----
mkdirSync(join(HOME, '.holt'), { recursive: true });
writeFileSync(join(HOME, '.holt', 'trust.json'), JSON.stringify({ trusted: [WS_PHYS, WS] }, null, 2));

mkdirSync(join(WS, '.holt', 'memory'), { recursive: true });

// A v4 config WITHOUT a wiki block: proves the v4 -> v5 migration is additive.
const v4Config = {
  version: 4,
  defaultBrain: 'claude',
  brains: {
    claude: { id: 'claude', label: 'Claude Code', command: 'node', args: [FAKE_BRAIN], enabled: true },
    codex: { id: 'codex', label: 'Codex (OpenAI)', command: 'codex', args: ['exec'], enabled: false },
    gemini: { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['-p'], enabled: false },
  },
  apiBrains: [],
  outputFormat: 'markdown',
  memory: { extractFacts: true },
};
writeFileSync(join(WS, '.holt', 'config.json'), JSON.stringify(v4Config, null, 2));

// ---- seed facts directly into the store, with real embeddings from Ollama. ----
const OLLAMA = 'http://127.0.0.1:11434';
async function embed(text) {
  try {
    const res = await fetch(`${OLLAMA}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    });
    if (!res.ok) return undefined;
    const d = await res.json();
    return Array.isArray(d.embedding) ? d.embedding.map((x) => Math.round(x * 1e4) / 1e4) : undefined;
  } catch {
    return undefined;
  }
}

function factRow(id, content, emb, ts) {
  return JSON.stringify({ id, ts, session: 'seed', role: 'fact', content, emb });
}

async function seedFacts(facts) {
  const lines = [];
  let ts = Date.now() - facts.length * 1000;
  for (const [id, content] of facts) {
    const e = await embed(content);
    lines.push(factRow(id, content, e, ts));
    ts += 1000;
  }
  writeFileSync(join(WS, '.holt', 'memory', 'turns.jsonl'), lines.join('\n') + '\n');
  // Also a facts.md so `holt memory facts` has something (optional).
  writeFileSync(
    join(WS, '.holt', 'memory', 'facts.md'),
    '# Holt facts\n\n## 2026-07-06\n' + facts.map(([, c]) => `- ${c}`).join('\n') + '\n',
  );
}

async function main() {
  const embeddable = await embed('probe');
  console.log(`# Ollama embeddings available: ${embeddable ? 'yes (routing tested)' : 'no (catch-all routing)'}`);

  // Two topic clusters + one near-duplicate of cluster A (should route to A, not dup).
  await seedFacts([
    ['f1aaaaaa', 'Debashis is targeting the Netherlands as his primary job market via the HSM visa route.'],
    ['f2bbbbbb', 'The Netherlands 30 percent ruling gives a tax advantage to skilled migrants.'],
    ['f3cccccc', 'Astrika is a Jyotish SaaS with a backend on Hetzner and a frontend on Vercel.'],
    ['f4dddddd', 'Astrika uses Razorpay for live payments and has an admin secret for the credits API.'],
  ]);

  // ===== config migration v4 -> v5 (via memory command, which loads config) =====
  const mem = runCli(['memory']);
  check('memory stats still works (config loads)', mem.status === 0 && /Holt memory/.test(mem.stdout), mem.stderr.trim());
  check('memory sees 4 seeded facts', /facts\s+4/.test(mem.stdout));

  // ===== (a) first sync: creates pages + index + provenance + [[links]] =====
  const sync1 = runCli(['wiki', 'sync']);
  check('wiki sync exits 0', sync1.status === 0, sync1.stderr.trim());
  check('wiki sync reports facts integrated', /facts integrated\s+[1-9]/.test(sync1.stdout), sync1.stdout.trim().slice(-200));

  const wikiPath = join(WS, '.holt', 'wiki');
  const pageFiles = existsSync(wikiPath) ? readdirSync(wikiPath).filter((f) => f.endsWith('.md') && f !== 'index.md') : [];
  check('wiki pages were written', pageFiles.length >= 1, `pages: ${pageFiles.join(', ')}`);
  check('index.md written', existsSync(join(wikiPath, 'index.md')));
  check('state marker written', existsSync(join(wikiPath, '.state.json')));

  // provenance + wikilinks on at least one page
  let sawSources = false, sawLink = false, sawFrontmatterTitle = false;
  for (const f of pageFiles) {
    const t = readFileSync(join(wikiPath, f), 'utf8');
    if (/^sources: .+/m.test(t) && /f[1-4]/.test(t)) sawSources = true;
    if (/\[\[[^\]]+\]\]/.test(t)) sawLink = true;
    if (/^title: .+/m.test(t)) sawFrontmatterTitle = true;
  }
  check('page has provenance (sources with fact ids)', sawSources);
  check('page has [[wikilinks]]', sawLink);
  check('page has frontmatter title', sawFrontmatterTitle);
  check('index.md lists [[pages]]', /\[\[/.test(readFileSync(join(wikiPath, 'index.md'), 'utf8')));

  const pageCountAfterSync1 = pageFiles.length;

  // ===== (a cont.) second sync integrates a NEW near-duplicate fact; no dup page =====
  // Append a near-duplicate of the NL cluster with a newer ts so it is "fresh".
  const existing = readFileSync(join(WS, '.holt', 'memory', 'turns.jsonl'), 'utf8').trimEnd();
  const dupEmb = await embed('The Netherlands remains the main job-search target using the highly skilled migrant visa.');
  const newRow = factRow('f5eeeeee', 'The Netherlands remains the main job-search target using the highly skilled migrant visa.', dupEmb, Date.now() + 5000);
  writeFileSync(join(WS, '.holt', 'memory', 'turns.jsonl'), existing + '\n' + newRow + '\n');

  const sync2 = runCli(['wiki', 'sync']);
  check('second wiki sync exits 0', sync2.status === 0, sync2.stderr.trim());
  const pageFiles2 = readdirSync(wikiPath).filter((f) => f.endsWith('.md') && f !== 'index.md');
  if (embeddable) {
    check('near-duplicate fact did NOT create a new page (routing)', pageFiles2.length === pageCountAfterSync1, `before ${pageCountAfterSync1}, after ${pageFiles2.length}`);
    check('second sync updated a page (not just created)', /pages updated\s+[1-9]/.test(sync2.stdout) || /No new facts/.test(sync2.stdout), sync2.stdout.trim().slice(-160));
  } else {
    check('second sync ran (catch-all routing)', pageFiles2.length >= 1);
  }

  // ===== (c) list / show / status =====
  const list = runCli(['wiki', 'list']);
  check('wiki list exits 0 and shows pages', list.status === 0 && /Wiki pages/.test(list.stdout), list.stderr.trim());

  const someSlug = pageFiles2[0].slice(0, -3);
  const show = runCli(['wiki', 'show', someSlug]);
  check('wiki show prints a page', show.status === 0 && /title:/.test(show.stdout), show.stderr.trim());

  const status = runCli(['wiki', 'status']);
  check('wiki status exits 0', status.status === 0, status.stderr.trim());
  check('status shows maintainer', /maintainer\s+brain/.test(status.stdout));
  check('status shows localModel', /localModel\s+qwen2\.5:7b/.test(status.stdout));
  check('status shows RAM recommendation', /recommended local model/.test(status.stdout), (status.stdout.match(/RAM .*/) || [''])[0]);

  const bare = runCli(['wiki']);
  check('bare "holt wiki" shows status', bare.status === 0 && /Holt wiki/.test(bare.stdout));

  const setup = runCli(['wiki', 'setup']);
  check('wiki setup prints model recommendation + pull line', setup.status === 0 && /ollama pull/.test(setup.stdout));

  // ===== (b) rebuild regenerates from facts (confirm prompt = y) =====
  const rebuild = runCli(['wiki', 'rebuild'], { input: 'y\n' });
  check('wiki rebuild exits 0', rebuild.status === 0, rebuild.stderr.trim());
  check('wiki rebuild reports pages', /Wiki rebuilt/.test(rebuild.stdout), rebuild.stdout.trim().slice(-160));
  const pageFiles3 = readdirSync(wikiPath).filter((f) => f.endsWith('.md') && f !== 'index.md');
  check('rebuild produced pages', pageFiles3.length >= 1, `pages: ${pageFiles3.length}`);

  // rebuild declined keeps pages
  const rebuildNo = runCli(['wiki', 'rebuild'], { input: 'n\n' });
  check('wiki rebuild decline is clean', rebuildNo.status === 0 && /Kept/.test(rebuildNo.stdout));

  // ===== (d) maintainer: 'local' with a dead Ollama port degrades gracefully =====
  // Switch config to local, point OLLAMA at a dead port. Should fall back to brain
  // (which is the fake brain) and print a clear note, never crash.
  const cfg = JSON.parse(readFileSync(join(WS, '.holt', 'config.json'), 'utf8'));
  cfg.wiki = { maintainer: 'local', localModel: 'qwen2.5:7b' };
  writeFileSync(join(WS, '.holt', 'config.json'), JSON.stringify(cfg, null, 2));
  // add a fresh fact so sync has work to do
  const cur = readFileSync(join(WS, '.holt', 'memory', 'turns.jsonl'), 'utf8').trimEnd();
  writeFileSync(
    join(WS, '.holt', 'memory', 'turns.jsonl'),
    cur + '\n' + factRow('f6ffffff', 'Holt is an open-source personal agent OS with zero runtime dependencies.', await embed('Holt is an open-source personal agent OS with zero runtime dependencies.'), Date.now() + 9000) + '\n',
  );
  const deadEnv = { ...env, HOLT_OLLAMA_URL: 'http://127.0.0.1:59999' };
  const localSync = runCli(['wiki', 'sync'], { env: deadEnv });
  check('local-maintainer sync never crashes', localSync.status === 0, localSync.stderr.trim());
  check('local-maintainer degrades with a clear note (pull/fallback)', /pull|Falling back|not reachable|not pulled/i.test(localSync.stdout), localSync.stdout.trim().slice(-220));

  const localStatus = runCli(['wiki', 'status'], { env: deadEnv });
  check('local status reports Ollama not reachable', /not reachable|not pulled/i.test(localStatus.stdout), (localStatus.stdout.match(/local status.*/) || [''])[0]);

  // reset config back to brain for graph test cleanliness
  cfg.wiki = { maintainer: 'brain', localModel: 'qwen2.5:7b' };
  writeFileSync(join(WS, '.holt', 'config.json'), JSON.stringify(cfg, null, 2));

  // ===== existing graph still works, and (e) graph --wiki renders =====
  const graphMem = runCli(['graph', '--no-open', '--no-wiki']);
  check('holt graph (memory only) still works', graphMem.status === 0 && /Memory graph built/.test(graphMem.stdout), graphMem.stderr.trim());

  const graphWiki = runCli(['graph', '--no-open', '--wiki']);
  check('holt graph --wiki exits 0', graphWiki.status === 0, graphWiki.stderr.trim());
  check('graph --wiki reports wiki page nodes', /wiki pages/.test(graphWiki.stdout), graphWiki.stdout.trim().slice(-160));
  const graphHtml = readFileSync(join(WS, '.holt', 'graph.html'), 'utf8');
  check('graph HTML is well-formed (doctype + closing html)', /^<!doctype html>/i.test(graphHtml) && /<\/html>\s*$/.test(graphHtml.trim() + '\n'));
  check('graph HTML embeds wiki nodes', /"kind":"wiki"/.test(graphHtml));
  check('graph HTML embeds wikilink edges', /"kind":"wikilink"/.test(graphHtml));
  check('graph HTML has no em-dash', !graphHtml.includes(String.fromCharCode(0x2014)));

  // graph --wiki on an EMPTY wiki (fresh workspace) must not crash
  const WS2 = mkdtempSync(join(tmpdir(), 'holt-ws2-'));
  const WS2_PHYS = realpathSync(WS2);
  const t = JSON.parse(readFileSync(join(HOME, '.holt', 'trust.json'), 'utf8'));
  t.trusted.push(WS2_PHYS, WS2);
  writeFileSync(join(HOME, '.holt', 'trust.json'), JSON.stringify(t));
  mkdirSync(join(WS2, '.holt', 'memory'), { recursive: true });
  writeFileSync(join(WS2, '.holt', 'config.json'), JSON.stringify(cfg, null, 2));
  writeFileSync(join(WS2, '.holt', 'memory', 'turns.jsonl'), factRow('g1', 'a lone turn', undefined, Date.now()).replace('"fact"', '"user"') + '\n');
  const graphEmptyWiki = spawnSync('node', [CLI, 'graph', '--no-open', '--wiki'], { cwd: WS2, env, encoding: 'utf8' });
  check('graph --wiki on empty wiki does not crash', graphEmptyWiki.status === 0, graphEmptyWiki.stderr.trim());

  // ===== recall integration: wiki content is searchable =====
  const search = runCli(['memory', 'search', 'Netherlands job market visa']);
  check('wiki content is recallable via memory search', search.status === 0 && search.stdout.length > 0, search.stderr.trim());

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  console.log(`HOME=${HOME}\nWS=${WS}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke harness error:', e);
  process.exit(2);
});
