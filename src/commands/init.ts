import { loadConfig, saveConfig, defaultConfig, BRAIN_IDS, BRAIN_DEFS, BRAIN_SETUP, type BrainId, type ApiBrain } from '../config';
import { isInstalled } from '../brains';
import { installAlias } from '../alias';
import { runInteractive } from '../install';
import { ensureTrusted, workspace } from '../workspace';
import { embeddingsAvailable, resetEmbedProbe, EMBED_MODEL } from '../memory';
import { loadTelegramConfig } from '../telegram';
import { connectApiBrain } from './setting';
import { setupTelegram } from './telegram';
import { voiceInterview } from './voice';
import { c, createReader } from '../ui';

function parseBrains(raw: string, found: BrainId[]): BrainId[] {
  const s = raw.trim().toLowerCase();
  if (s === '') return found.length ? found : [...BRAIN_IDS];
  if (s === 'all') return [...BRAIN_IDS];
  const picked = s.split(/[\s,]+/).filter((x) => (BRAIN_IDS as string[]).includes(x)) as BrainId[];
  if (picked.length) return [...new Set(picked)];
  return found.length ? found : ['claude'];
}

/** `holt init`: trust folder, choose + install brains, sign in, set default and launch command. */
export async function init(): Promise<void> {
  const { ask, close } = createReader();

  if (!(await ensureTrusted(ask))) { close(); return; }

  console.log(c.accent('Holt setup') + c.dim(`  (${workspace()})`) + '\n');
  console.log('Looking for agent CLIs on your machine...\n');
  const found: BrainId[] = [];
  for (const id of BRAIN_IDS) {
    const ok = isInstalled(BRAIN_DEFS[id].command);
    console.log(`  ${ok ? c.green('found  ') : c.dim('missing')}  ${BRAIN_DEFS[id].label} (${BRAIN_DEFS[id].command})`);
    if (ok) found.push(id);
  }
  console.log('');

  const chosen = parseBrains(
    (await ask('Which brains do you want? claude, codex, gemini (comma-separated, or "all"): ')) ?? '',
    found,
  );
  console.log(c.dim(`  using: ${chosen.join(', ')}`));

  const toInstall = chosen.filter((id) => !isInstalled(BRAIN_DEFS[id].command));
  const loginWanted = new Set<BrainId>();
  for (const id of toInstall) {
    const a = ((await ask(`  ${BRAIN_DEFS[id].label} is not installed. Sign in after install? [Y/n] `)) ?? '').trim().toLowerCase();
    if (a !== 'n' && a !== 'no') loginWanted.add(id);
  }

  // Optional: connect a direct API brain (raw key, no CLI needed).
  const connectedApiBrains: ApiBrain[] = [];
  const apiAns = ((await ask('\nAlso connect a direct API brain (raw key, no CLI needed)? [y/N] ')) ?? '').trim().toLowerCase();
  if (apiAns === 'y' || apiAns === 'yes') {
    const holder = defaultConfig();
    const brain = await connectApiBrain(ask, holder);
    if (brain) connectedApiBrains.push(brain);
  }

  const defPick: BrainId = chosen.includes('claude') ? 'claude' : (chosen[0] as BrainId);
  const dans = ((await ask(`\nDefault brain? [${chosen.join('/')}] (${defPick}): `)) ?? '').trim() as BrainId;
  const defaultBrain: BrainId = chosen.includes(dans) ? dans : defPick;

  const aliasAns = ((await ask('Launch command? Type a custom word like "ai", or press enter to keep "holt": ')) ?? '').trim();
  let aliasNote = '';
  let aliasNeedsSource = '';
  let aliasWorked = false;
  if (aliasAns && aliasAns !== 'holt') {
    const r = installAlias(aliasAns);
    aliasWorked = r.ok;
    if (r.ok && r.immediate) aliasNote = c.green(`  "${aliasAns}" is ready to use right now (launcher at ${r.file}).`);
    else if (r.ok) {
      aliasNote = c.green(`  alias "${aliasAns}" -> holt chat added to ${r.file}`);
      aliasNeedsSource = r.file;
    } else aliasNote = c.red('  ' + r.message);
  }

  // Private semantic memory: local Ollama + a small embed model. No keys, nothing leaves the machine.
  let wantMemorySetup = false;
  const embedReady = await embeddingsAvailable();
  if (embedReady) {
    console.log(c.dim('\nSemantic memory: ready (local Ollama with ' + EMBED_MODEL + ' detected).'));
  } else {
    const ollamaHere = isInstalled('ollama');
    const q = ollamaHere
      ? `Semantic memory needs a local embed model. Pull ${EMBED_MODEL} with Ollama now? [Y/n] `
      : 'Enable private semantic memory? Installs Ollama plus a small local embed model. Everything stays on your machine. [Y/n] ';
    const a = ((await ask('\n' + q)) ?? '').trim().toLowerCase();
    wantMemorySetup = a !== 'n' && a !== 'no';
    if (!wantMemorySetup) console.log(c.dim('  Okay. Memory still works with keyword recall; run "holt init" again anytime.'));
  }

  // Optional: connect Telegram to chat with Holt from your phone.
  if (!loadTelegramConfig()) {
    const tgAns = ((await ask('\nChat with Holt from your phone over Telegram? [y/N] ')) ?? '').trim().toLowerCase();
    if (tgAns === 'y' || tgAns === 'yes') await setupTelegram(ask);
  }

  close(); // release stdin before running interactive installs/logins

  // Auto-install chosen brains that are missing.
  for (const id of toInstall) {
    const s = BRAIN_SETUP[id];
    console.log('\n' + c.accent(`Installing ${BRAIN_DEFS[id].label}`) + c.dim(`  (${s.install.join(' ')})`));
    const code = await runInteractive(s.install[0] as string, s.install.slice(1));
    console.log(code === 0 ? c.green(`  ${BRAIN_DEFS[id].label} installed.`) : c.red(`  Install failed (exit ${code}). Run manually: ${s.install.join(' ')}`));
  }

  // Hand off to each tool's own sign-in.
  for (const id of toInstall) {
    if (!loginWanted.has(id) || !isInstalled(BRAIN_DEFS[id].command)) continue;
    const s = BRAIN_SETUP[id];
    console.log('\n' + c.accent(`Sign in to ${BRAIN_DEFS[id].label}`));
    console.log(c.dim(`  Starting "${s.login.join(' ')}". Complete sign-in, then exit that tool to return here.`));
    await runInteractive(s.login[0] as string, s.login.slice(1));
  }

  // Set up private semantic memory if asked.
  if (wantMemorySetup) {
    if (!isInstalled('ollama')) {
      if (process.platform === 'darwin' && isInstalled('brew')) {
        console.log('\n' + c.accent('Installing Ollama') + c.dim('  (brew install ollama)'));
        const code = await runInteractive('brew', ['install', 'ollama']);
        if (code === 0) await runInteractive('brew', ['services', 'start', 'ollama']);
        else console.log(c.red('  Install failed. Get Ollama from https://ollama.com/download and run "holt init" again.'));
      } else {
        console.log(c.dim('\n  Get Ollama from https://ollama.com/download, then run "holt init" again to finish memory setup.'));
      }
    }
    if (isInstalled('ollama')) {
      console.log('\n' + c.accent('Pulling embed model') + c.dim(`  (ollama pull ${EMBED_MODEL})`));
      const code = await runInteractive('ollama', ['pull', EMBED_MODEL]);
      if (code !== 0) {
        console.log(c.dim('  Could not pull. Start Ollama (open the app or run "ollama serve"), then run:'));
        console.log(c.dim(`    ollama pull ${EMBED_MODEL}`));
      }
      resetEmbedProbe();
      if (await embeddingsAvailable()) console.log(c.green('  Semantic memory is ready. Chats in trusted folders are stored and recalled locally.'));
    }
  }

  // Write per-workspace config.
  const cfg = loadConfig() ?? defaultConfig();
  for (const id of BRAIN_IDS) cfg.brains[id].enabled = chosen.includes(id) && isInstalled(BRAIN_DEFS[id].command);
  for (const b of connectedApiBrains) if (!cfg.apiBrains.some((a) => a.id === b.id)) cfg.apiBrains.push(b);
  cfg.defaultBrain = cfg.brains[defaultBrain].enabled
    ? defaultBrain
    : (BRAIN_IDS.find((id) => cfg.brains[id].enabled) ?? cfg.apiBrains[0]?.id ?? null);
  saveConfig(cfg);

  console.log('\n' + c.green('Saved to ./.holt/config.json'));
  if (aliasNote) console.log(aliasNote);
  if (cfg.defaultBrain) {
    if (aliasWorked && !aliasNeedsSource) {
      console.log('Start chatting:  ' + c.accent(aliasAns) + '\n');
    } else if (aliasNeedsSource) {
      // rc-alias fallback: the current shell has not read the rc file yet.
      console.log('\nStart chatting:');
      console.log('  ' + c.accent(`source ${aliasNeedsSource}`) + c.dim('   (once; new terminals will not need it)'));
      console.log('  ' + c.accent(aliasAns) + '\n');
      console.log(c.dim('  Or right now, without sourcing: holt chat\n'));
    } else {
      console.log('Start chatting:  ' + c.accent('holt chat') + '\n');
    }
  } else {
    console.log(c.dim('No brain is ready yet. Install one, then run "holt init" again.\n'));
  }

  // Optional: teach Holt how you write, so it can draft in your voice. Additive
  // and opt-in. A fresh reader since the setup reader was closed for installs.
  const voiceReader = createReader();
  const voiceAns = ((await voiceReader.ask('Want Holt to learn how you write, so it can draft in your voice? [y/N] ')) ?? '').trim().toLowerCase();
  voiceReader.close();
  if (voiceAns === 'y' || voiceAns === 'yes') {
    await voiceInterview();
  } else {
    console.log(c.dim('  Skipped. Run "holt voice" anytime to set up your writing voice.\n'));
  }
}
