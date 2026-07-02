import { loadConfig, saveConfig, defaultConfig, BRAIN_IDS, BRAIN_DEFS, BRAIN_SETUP, type BrainId } from '../config';
import { isInstalled } from '../brains';
import { installAlias } from '../alias';
import { runInteractive } from '../install';
import { ensureTrusted, workspace } from '../workspace';
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

  const defPick: BrainId = chosen.includes('claude') ? 'claude' : (chosen[0] as BrainId);
  const dans = ((await ask(`\nDefault brain? [${chosen.join('/')}] (${defPick}): `)) ?? '').trim() as BrainId;
  const defaultBrain: BrainId = chosen.includes(dans) ? dans : defPick;

  const aliasAns = ((await ask('Launch command? Type a custom word like "ai", or press enter to keep "holt": ')) ?? '').trim();
  let aliasNote = '';
  if (aliasAns && aliasAns !== 'holt') {
    if (isInstalled(aliasAns)) console.log(c.dim(`  note: "${aliasAns}" already exists; the alias will shadow it in new shells.`));
    const r = installAlias(aliasAns);
    aliasNote = r.ok ? c.green(`  alias "${aliasAns}" -> holt chat added to ${r.file} (run: source ${r.file})`) : c.red('  ' + r.message);
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

  // Write per-workspace config.
  const cfg = loadConfig() ?? defaultConfig();
  for (const id of BRAIN_IDS) cfg.brains[id].enabled = chosen.includes(id) && isInstalled(BRAIN_DEFS[id].command);
  cfg.defaultBrain = cfg.brains[defaultBrain].enabled ? defaultBrain : (BRAIN_IDS.find((id) => cfg.brains[id].enabled) ?? null);
  saveConfig(cfg);

  console.log('\n' + c.green('Saved to ./.holt/config.json'));
  if (aliasNote) console.log(aliasNote);
  if (cfg.defaultBrain) console.log('Start chatting:  ' + c.accent(aliasAns && aliasAns !== 'holt' ? aliasAns : 'holt chat') + '\n');
  else console.log(c.dim('No brain is ready yet. Install one, then run "holt init" again.\n'));
}
