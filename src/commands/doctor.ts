/**
 * `holt doctor`: look at this machine and its installed tools, then recommend,
 * in plain language, the best way to run Holt here across every aspect.
 *
 * Read-only advice. It touches no config and needs no trust gate. Every probe
 * degrades gracefully: a failed check prints "unknown" or a safe default and the
 * report still finishes with exit code 0.
 */
import { detect, recommendLocalModel } from '../specs';
import { isInstalled } from '../brains';
import { embeddingsAvailable, EMBED_MODEL } from '../memory';
import { loadTelegramConfig } from '../telegram';
import { loadConfig, BRAIN_DEFS, BRAIN_IDS } from '../config';
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

export async function doctor(): Promise<void> {
  const specs = detect();
  const steps: string[] = [];

  console.log('\n' + c.bold('Holt doctor') + c.dim('  a look at this machine and how best to run Holt on it'));

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
  if (embedOk) {
    good(`Ollama reachable and "${EMBED_MODEL}" is present. Memory recall is semantic, private, and local.`);
  } else {
    note(`Ollama with "${EMBED_MODEL}" not reachable at ${OLLAMA_URL}.`);
    note('Without it, Holt still remembers, but recall falls back to keyword match.');
    warn(`Recommendation: enable local embeddings. Install Ollama, then: ollama pull ${EMBED_MODEL}`);
    steps.push(`Enable semantic memory: ollama pull ${EMBED_MODEL}`);
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

  // 6. Recommended next steps --------------------------------------------
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
