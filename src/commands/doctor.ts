/**
 * `holt doctor`: look at this machine and its installed tools, then recommend,
 * in plain language, the best way to run Holt here across every aspect.
 *
 * Read-only advice. It touches no config and needs no trust gate. Every probe
 * degrades gracefully: a failed check prints "unknown" or a safe default and the
 * report still finishes with exit code 0.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { detect, recommendLocalModel } from '../specs';
import { isInstalled } from '../brains';
import {
  embeddingsAvailable,
  resetEmbedProbe,
  loadTurns,
  backfillEmbeddings,
  EMBED_MODEL,
} from '../memory';
import { loadTelegramConfig } from '../telegram';
import { loadConfig, lastConfigRepair, BRAIN_DEFS, BRAIN_IDS } from '../config';
import { wsHoltDir } from '../workspace';
import { c } from '../ui';

// Same base URL resolution as src/memory.ts, surfaced here only for the hint.
const OLLAMA_URL = process.env.HOLT_OLLAMA_URL || 'http://127.0.0.1:11434';

function header(title: string): void {
  console.log('\n' + c.accent(title));
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(12)}${value}`);
}

function note(text: string): void {
  console.log('  ' + c.dim(text));
}

function good(text: string): void {
  console.log('  ' + c.green(text));
}

function warn(text: string): void {
  console.log('  ' + c.red(text));
}

/** Model names Ollama reports, or null when the daemon is unreachable. */
async function ollamaTags(): Promise<string[] | null> {
  const url = process.env.HOLT_OLLAMA_URL || 'http://127.0.0.1:11434';
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => String(m.name ?? ''));
  } catch {
    return null;
  }
}

/**
 * `--fix` repair for semantic memory: start the Ollama daemon if it is
 * installed but not running, pull the embed model if it is missing, then
 * backfill embeddings for any memories saved while it was down. Every step is
 * best-effort and reports what it did; nothing here throws.
 */
async function fixSemanticMemory(fixed: string[]): Promise<boolean> {
  let tags = await ollamaTags();
  if (tags === null) {
    if (!isInstalled('ollama')) {
      note('Ollama is not installed, so there is nothing to start.');
      note(
        process.platform === 'darwin'
          ? 'Install it with: brew install ollama   (then run "holt doctor --fix" again)'
          : 'Install it from https://ollama.com/download, then run "holt doctor --fix" again.',
      );
      return false;
    }
    note('Ollama is installed but not running. Starting it...');
    try {
      const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch {
      warn('Could not start Ollama. Start it yourself (open the Ollama app or run "ollama serve").');
      return false;
    }
    for (let i = 0; i < 16 && tags === null; i++) {
      await new Promise((r) => setTimeout(r, 500));
      tags = await ollamaTags();
    }
    if (tags === null) {
      warn('Ollama did not come up. Open the Ollama app once, then run "holt doctor --fix" again.');
      return false;
    }
    fixed.push('Started the Ollama daemon.');
  }
  if (!tags.some((t) => t.startsWith(EMBED_MODEL))) {
    note(`The "${EMBED_MODEL}" model is missing. Downloading it (one-time, ~275 MB)...`);
    const r = spawnSync('ollama', ['pull', EMBED_MODEL], { stdio: 'inherit' });
    if (r.status !== 0) {
      warn(`Could not download ${EMBED_MODEL}. Check your internet connection and retry.`);
      return false;
    }
    fixed.push(`Downloaded the "${EMBED_MODEL}" model.`);
  }
  resetEmbedProbe();
  return embeddingsAvailable();
}

export async function doctor(args: string[] = []): Promise<void> {
  const fix = args.includes('--fix');
  const fixed: string[] = [];
  const specs = detect();
  const steps: string[] = [];

  console.log('\n' + c.bold('Holt doctor') + c.dim(' · a look at this machine and how best to run Holt on it'));

  // 1. Machine ------------------------------------------------------------
  header('Machine');
  row('platform', `${specs.platform} / ${specs.arch}`);
  row('cpu', `${specs.cpuModel}${specs.cpuCount ? `  (${specs.cpuCount} cores)` : ''}`);
  row(
    'ram',
    specs.totalRamGB
      ? `${specs.totalRamGB} GB total, ${specs.freeRamGB} GB free`
      : 'unknown',
  );
  row('node', specs.nodeVersion);

  // 2. Brains -------------------------------------------------------------
  header('Brains');
  const installed: string[] = [];
  for (const id of BRAIN_IDS) {
    const def = BRAIN_DEFS[id];
    const here = isInstalled(def.command);
    if (here) installed.push(def.label);
    console.log(`  ${here ? c.green('installed') : c.dim('missing  ')}  ${def.label} ${c.dim(`(${def.command})`)}`);
  }
  // A configured folder may already point at an API brain; mention it if so.
  const cfg = loadConfig();
  const apiBrains = cfg?.apiBrains ?? [];
  if (apiBrains.length) {
    note(`API brains configured here: ${apiBrains.map((b) => b.id).join(', ')}`);
  }
  if (installed.length) {
    good(`Recommendation: use an installed CLI brain (${installed[0]}). No API keys needed.`);
  } else if (apiBrains.length) {
    good('Recommendation: no CLI brain installed, but you have an API brain configured. That works.');
  } else {
    warn('Recommendation: no brain available. Install one CLI brain (claude, codex, or gemini) or add an API brain.');
    steps.push('Install a brain: run "holt init" (or add an API brain in "holt setting").');
  }

  // 3. Semantic memory ----------------------------------------------------
  header('Semantic memory');
  let embedOk = false;
  try {
    embedOk = await embeddingsAvailable();
  } catch {
    embedOk = false;
  }
  if (!embedOk && fix) {
    embedOk = await fixSemanticMemory(fixed);
  }
  if (embedOk) {
    good(`Ollama reachable and "${EMBED_MODEL}" is present. Memory recall is semantic, private, and local.`);
    // Memories saved while Ollama was down have no embeddings. With --fix,
    // upgrade them now so recall quality is uniform again.
    if (fix && existsSync(wsHoltDir())) {
      const missing = loadTurns().filter((t) => !Array.isArray(t.emb)).length;
      if (missing > 0) {
        note(`${missing} memories in this folder lack embeddings. Upgrading them...`);
        const r = await backfillEmbeddings((done, total) => {
          process.stdout.write(`\r  embedding ${done}/${total}...`);
        });
        console.log('');
        if (r.embedded > 0) fixed.push(`Upgraded ${r.embedded} memories to semantic recall.`);
      }
    }
  } else {
    note(`Ollama with "${EMBED_MODEL}" not reachable at ${OLLAMA_URL}.`);
    note('Without it, Holt still remembers, but recall falls back to keyword match.');
    if (!fix) {
      warn('Recommendation: run "holt doctor --fix" to set this up automatically.');
      steps.push('Enable semantic memory: holt doctor --fix');
    }
  }

  // 4. Knowledge wiki maintainer -----------------------------------------
  header('Knowledge wiki maintainer');
  const rec = recommendLocalModel(specs.totalRamGB);
  note('Holt can keep your knowledge wiki with a hosted "brain" (rides your Claude plan) or a local model.');
  good('Default recommendation: "brain" (best quality, no extra RAM, uses the brain you already have).');
  if (rec.local && rec.model) {
    const alt = rec.alt ? ` (or ${rec.alt})` : '';
    console.log(
      '  ' +
        c.cyan('local option: ') +
        `${rec.model}${alt}${rec.size ? c.dim(`  ${rec.size}`) : ''} for this ${specs.totalRamGB || '?'} GB machine.`,
    );
    note(rec.note);
    note(`To use it locally: ollama pull ${rec.model}`);
  } else {
    note(rec.note);
    if (rec.model) note(`If you still want local: ollama pull ${rec.model} (${rec.size ?? 'small'}).`);
  }

  // 5. Always-on / Telegram ----------------------------------------------
  header('Always-on / Telegram');
  const tg = loadTelegramConfig();
  if (tg) {
    good('Telegram bot is configured. You can chat with Holt from your phone.');
  } else {
    note('No Telegram bot configured. Set one up to reach Holt from your phone: holt telegram setup');
  }
  note('Hosting tip: a low-power always-on machine (an old laptop, a Pi) is ideal for the bot and scheduled runs.');
  note('Heavy local models want more RAM, so keep those on your bigger machine and let the small box relay.');

  // 6. What --fix did ------------------------------------------------------
  if (fix) {
    header('Repairs');
    if (lastConfigRepair) fixed.push(`Moved a damaged settings file aside (${lastConfigRepair}).`);
    if (fixed.length === 0) good('Nothing needed repair.');
    else for (const f of fixed) good(f);
  }

  // 7. Recommended next steps --------------------------------------------
  header('Recommended next steps');
  // Suggest init when this folder is not set up yet.
  if (!cfg) {
    steps.unshift('Set up this folder: run "holt init".');
  }
  if (steps.length === 0) {
    good('You are in good shape. Run "holt chat" to start.');
  } else {
    let n = 1;
    for (const s of steps) console.log(`  ${c.accent(String(n++) + '.')} ${s}`);
  }
  console.log('');
}
