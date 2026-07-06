#!/usr/bin/env node
/**
 * Wiki AUTOPILOT smoke test. Runs the built CLI (dist/cli.js) in an ISOLATED
 * temp HOME + workspace with a FAKE brain (no real agent, no network beyond the
 * local Ollama used for embeddings/routing, which is optional). Covers the new
 * feature surface:
 *
 *   1. `holt wiki auto on|off` toggles wiki.autoSync in the folder config, and
 *      `holt wiki status` + `holt wiki auto` reflect it.
 *   2. auto-sync at CHAT session end: with autoSync on, a piped `holt chat`
 *      session that distills facts ALSO updates the wiki (a page appears) with
 *      no manual `holt wiki sync`. With autoSync off, the wiki is NOT updated.
 *   3. auto-sync at CAPTURE hook: a realistic Stop-hook stdin JSON in a trusted
 *      folder with autoSync on distills facts AND updates the wiki; stdout stays
 *      clean (protocol) and exit code is 0. With autoSync off it only captures.
 *   4. `holt wiki lint --fix` APPLIES the maintainer's corrections to page files
 *      (a seeded duplicate line is removed); without --fix, files are untouched.
 */
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

const OLLAMA = process.env.HOLT_OLLAMA_URL || 'http://127.0.0.1:11434';
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

function pageFiles(wikiPath) {
  return existsSync(wikiPath) ? readdirSync(wikiPath).filter((f) => f.endsWith('.md') && f !== 'index.md') : [];
}

// ---- isolated env + workspace factory ----
const HOME = mkdtempSync(join(tmpdir(), 'holt-home-'));
mkdirSync(join(HOME, '.holt'), { recursive: true });
const trusted = [];
writeFileSync(join(HOME, '.holt', 'trust.json'), JSON.stringify({ trusted }));

const env = { ...process.env, HOME, NO_COLOR: '1' };
delete env.HOLT_OLLAMA_URL;

function newWorkspace() {
  const WS = mkdtempSync(join(tmpdir(), 'holt-ws-'));
  const WS_PHYS = realpathSync(WS);
  trusted.push(WS_PHYS, WS); // pre-seed trust with the PHYSICAL path (/tmp -> /private/tmp)
  writeFileSync(join(HOME, '.holt', 'trust.json'), JSON.stringify({ trusted }));
  mkdirSync(join(WS, '.holt', 'memory'), { recursive: true });
  return { WS, WS_PHYS };
}

function writeConfig(WS, wiki) {
  const cfg = {
    version: 5,
    defaultBrain: 'claude',
    brains: {
      claude: { id: 'claude', label: 'Claude Code', command: 'node', args: [FAKE_BRAIN], enabled: true },
      codex: { id: 'codex', label: 'Codex (OpenAI)', command: 'codex', args: ['exec'], enabled: false },
      gemini: { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['-p'], enabled: false },
    },
    apiBrains: [],
    outputFormat: 'markdown',
    memory: { extractFacts: true },
    wiki,
  };
  writeFileSync(join(WS, '.holt', 'config.json'), JSON.stringify(cfg, null, 2));
}

function runCli(WS, args, opts = {}) {
  return spawnSync('node', [CLI, ...args], { cwd: WS, env, input: opts.input ?? '', encoding: 'utf8' });
}

function factRow(id, content, emb, ts) {
  return JSON.stringify({ id, ts, session: 'seed', role: 'fact', content, emb });
}

async function seedFacts(WS, facts) {
  const lines = [];
  let ts = Date.now() - facts.length * 1000;
  for (const [id, content] of facts) {
    lines.push(factRow(id, content, await embed(content), ts));
    ts += 1000;
  }
  writeFileSync(join(WS, '.holt', 'memory', 'turns.jsonl'), lines.join('\n') + '\n');
}

async function main() {
  const embeddable = await embed('probe');
  console.log(`# Ollama embeddings available: ${embeddable ? 'yes' : 'no (catch-all routing)'}`);

  // ===== 1. `holt wiki auto` toggle + status surfacing =====
  {
    const { WS } = newWorkspace();
    writeConfig(WS, { maintainer: 'brain', localModel: 'qwen2.5:7b' });

    const auto0 = runCli(WS, ['wiki', 'auto']);
    check('wiki auto (no arg) shows off by default', auto0.status === 0 && /off/i.test(auto0.stdout), auto0.stderr.trim());

    const on = runCli(WS, ['wiki', 'auto', 'on']);
    check('wiki auto on exits 0', on.status === 0 && /on/i.test(on.stdout), on.stderr.trim());
    const cfgAfterOn = JSON.parse(readFileSync(join(WS, '.holt', 'config.json'), 'utf8'));
    check('wiki auto on persists autoSync:true in config', cfgAfterOn.wiki.autoSync === true);

    const status = runCli(WS, ['wiki', 'status']);
    check('status surfaces auto-sync on', status.status === 0 && /auto-sync\s+on/.test(status.stdout), (status.stdout.match(/auto-sync.*/) || [''])[0]);

    const off = runCli(WS, ['wiki', 'auto', 'off']);
    check('wiki auto off exits 0', off.status === 0, off.stderr.trim());
    const cfgAfterOff = JSON.parse(readFileSync(join(WS, '.holt', 'config.json'), 'utf8'));
    check('wiki auto off persists autoSync:false', cfgAfterOff.wiki.autoSync === false);
    const status2 = runCli(WS, ['wiki', 'status']);
    check('status surfaces auto-sync off', /auto-sync\s+off/.test(status2.stdout));
  }

  // ===== 2. auto-sync at CHAT session end =====
  // With autoSync ON: a piped chat with >= 3 exchanges distills a fact (fake
  // brain returns a JSON array) and then auto-syncs -> wiki page appears.
  {
    const { WS } = newWorkspace();
    writeConfig(WS, { maintainer: 'brain', localModel: 'qwen2.5:7b', autoSync: true });
    const wikiPath = join(WS, '.holt', 'wiki');
    check('chat/autoSync-on: wiki empty before chat', pageFiles(wikiPath).length === 0);

    const chatInput = ['hello there', 'tell me more', 'and one more thing', '/exit', ''].join('\n');
    const chat = runCli(WS, ['chat'], { input: chatInput });
    check('chat session exits 0', chat.status === 0, chat.stderr.trim());
    check('chat distilled a fact', /distilled \d+ fact/.test(chat.stdout), chat.stdout.trim().slice(-160));
    check('chat printed "updated the wiki"', /updated the wiki/.test(chat.stdout), chat.stdout.trim().slice(-160));
    check('chat/autoSync-on: wiki page created without manual sync', pageFiles(wikiPath).length >= 1, `pages: ${pageFiles(wikiPath).join(', ')}`);
  }
  // With autoSync OFF/absent: chat distills a fact but the wiki stays empty.
  {
    const { WS } = newWorkspace();
    writeConfig(WS, { maintainer: 'brain', localModel: 'qwen2.5:7b' }); // autoSync absent
    const wikiPath = join(WS, '.holt', 'wiki');
    const chatInput = ['hello there', 'tell me more', 'and one more thing', '/exit', ''].join('\n');
    const chat = runCli(WS, ['chat'], { input: chatInput });
    check('chat/autoSync-off: session exits 0', chat.status === 0, chat.stderr.trim());
    check('chat/autoSync-off: did NOT print "updated the wiki"', !/updated the wiki/.test(chat.stdout));
    check('chat/autoSync-off: wiki NOT auto-created (backward compatible)', pageFiles(wikiPath).length === 0, `pages: ${pageFiles(wikiPath).join(', ')}`);
  }

  // ===== 3. auto-sync at CAPTURE hook (Stop) =====
  // Build a realistic Claude Code JSONL transcript + Stop-hook stdin JSON.
  function writeTranscript(WS) {
    const tpath = join(WS, 'transcript.jsonl');
    const recs = [
      { type: 'user', message: { role: 'user', content: 'I decided to move all infra to Hetzner next month.' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ text: 'Noted: infra migrates to Hetzner next month.' }] } },
      { type: 'user', message: { role: 'user', content: 'Also the launch date is fixed for August 15.' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ text: 'Recorded the August 15 launch date.' }] } },
      { type: 'user', message: { role: 'user', content: 'And the budget cap is 20000 rupees a month.' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ text: 'Budget cap 20000 rupees per month saved.' }] } },
    ];
    writeFileSync(tpath, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return tpath;
  }
  function stopStdin(WS, tpath) {
    return JSON.stringify({
      hook_event_name: 'Stop',
      transcript_path: tpath,
      cwd: WS,
      session_id: 'sess-abc123',
      stop_hook_active: false,
    });
  }
  // autoSync ON: captures facts AND updates the wiki; stdout clean; exit 0.
  {
    const { WS } = newWorkspace();
    writeConfig(WS, { maintainer: 'brain', localModel: 'qwen2.5:7b', autoSync: true });
    const tpath = writeTranscript(WS);
    const wikiPath = join(WS, '.holt', 'wiki');
    const cap = runCli(WS, ['hook', 'capture'], { input: stopStdin(WS, tpath) });
    check('capture hook exits 0 (autoSync on)', cap.status === 0, cap.stderr.trim());
    check('capture hook stdout is CLEAN (protocol)', cap.stdout === '' || cap.stdout.trim() === '', JSON.stringify(cap.stdout.slice(0, 80)));
    check('capture hook saved facts (stderr note)', /saved \d+ fact/.test(cap.stderr), cap.stderr.trim().slice(-160));
    check('capture hook updated the wiki (stderr note)', /updated the wiki/.test(cap.stderr), cap.stderr.trim().slice(-160));
    check('capture/autoSync-on: wiki page created ambiently', pageFiles(wikiPath).length >= 1, `pages: ${pageFiles(wikiPath).join(', ')}`);
  }
  // autoSync OFF: captures facts only; wiki untouched; stdout clean; exit 0.
  {
    const { WS } = newWorkspace();
    writeConfig(WS, { maintainer: 'brain', localModel: 'qwen2.5:7b' });
    const tpath = writeTranscript(WS);
    const wikiPath = join(WS, '.holt', 'wiki');
    const cap = runCli(WS, ['hook', 'capture'], { input: stopStdin(WS, tpath) });
    check('capture hook exits 0 (autoSync off)', cap.status === 0, cap.stderr.trim());
    check('capture hook stdout clean (autoSync off)', cap.stdout.trim() === '');
    check('capture/autoSync-off: saved facts', /saved \d+ fact/.test(cap.stderr), cap.stderr.trim().slice(-160));
    check('capture/autoSync-off: wiki NOT updated', !/updated the wiki/.test(cap.stderr) && pageFiles(wikiPath).length === 0);
  }

  // ===== 4. lint --fix APPLIES; lint without --fix leaves files untouched =====
  {
    const { WS } = newWorkspace();
    writeConfig(WS, { maintainer: 'brain', localModel: 'qwen2.5:7b' });
    await seedFacts(WS, [['x1', 'A seed fact so a page exists.']]);
    // Sync to create at least one page.
    runCli(WS, ['wiki', 'sync']);
    const wikiPath = join(WS, '.holt', 'wiki');
    const files = pageFiles(wikiPath);
    check('lint setup: a page exists to lint', files.length >= 1, `pages: ${files.join(', ')}`);

    // Inject a fixable duplicate line into the first page body (the fake brain
    // removes any line containing DUPLICATE_LINE under --fix).
    const target = join(wikiPath, files[0]);
    const before = readFileSync(target, 'utf8');
    const withDup = before.replace(/(\n> [^\n]*\n)/, `$1\nDUPLICATE_LINE this is a redundant contradictory line.\n`);
    writeFileSync(target, withDup);
    check('lint setup: duplicate line injected', readFileSync(target, 'utf8').includes('DUPLICATE_LINE'));

    // lint WITHOUT --fix: prints proposals, leaves the file untouched.
    const snapshotBefore = readFileSync(target, 'utf8');
    const lint = runCli(WS, ['wiki', 'lint']);
    check('lint (no --fix) exits 0', lint.status === 0, lint.stderr.trim());
    check('lint (no --fix) prints a report', /CONTRADICTIONS|DUPLICATES|GAPS/.test(lint.stdout), lint.stdout.trim().slice(-160));
    check('lint (no --fix) leaves file UNTOUCHED', readFileSync(target, 'utf8') === snapshotBefore);
    check('lint (no --fix) duplicate line still present', readFileSync(target, 'utf8').includes('DUPLICATE_LINE'));

    // lint --fix: applies the correction (removes the DUPLICATE_LINE), file changes.
    const fix = runCli(WS, ['wiki', 'lint', '--fix']);
    check('lint --fix exits 0', fix.status === 0, fix.stderr.trim());
    check('lint --fix prints backup/git note', /git|back it up|recover/i.test(fix.stdout), fix.stdout.trim().slice(0, 160));
    check('lint --fix reports pages rewritten', /pages rewritten\s+[1-9]/.test(fix.stdout), fix.stdout.trim().slice(-200));
    const after = readFileSync(target, 'utf8');
    check('lint --fix REMOVED the duplicate line (page content changed)', !after.includes('DUPLICATE_LINE'));
    check('lint --fix preserved frontmatter sources (provenance intact)', /^sources: .+/m.test(after) && /^title: .+/m.test(after));
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  console.log(`HOME=${HOME}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('autopilot smoke harness error:', e);
  process.exit(2);
});
