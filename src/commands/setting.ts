import { loadConfig, saveConfig, defaultConfig, BRAIN_IDS, type HoltConfig, type BrainId } from '../config';
import { isInstalled } from '../brains';
import { installAlias, removeAlias, currentAlias } from '../alias';
import { ensureTrusted } from '../workspace';
import { c, createReader, type Ask } from '../ui';

function printStatus(cfg: HoltConfig): void {
  console.log('\n' + c.accent('Holt settings') + c.dim('  (this folder)'));
  for (const id of BRAIN_IDS) {
    const b = cfg.brains[id];
    const tags = [
      b.enabled ? c.green('enabled') : (isInstalled(b.command) ? c.dim('installed, off') : c.dim('not installed')),
      cfg.defaultBrain === id ? c.accent('default') : '',
    ].filter(Boolean).join('  ');
    console.log(`  ${id.padEnd(7)} ${b.label.padEnd(16)} ${tags}`);
  }
  console.log(c.dim(`  launch command: ${currentAlias() || 'holt (default)'}`));
  console.log('\n  ' + c.dim('[d] default brain   [t] toggle brain   [a] launch command   [enter] done'));
}

/** Interactive settings loop. Reuses a caller-provided prompt so it can run inside chat. */
export async function runSettings(ask: Ask): Promise<HoltConfig> {
  let cfg = loadConfig() ?? defaultConfig();
  while (true) {
    printStatus(cfg);
    const raw = await ask('  > ');
    const choice = (raw ?? '').trim().toLowerCase();
    if (raw === null || choice === '' || choice === 'q') break;

    if (choice === 'd') {
      const enabled = BRAIN_IDS.filter((id) => cfg.brains[id].enabled);
      if (enabled.length === 0) { console.log(c.dim('  No enabled brains. Toggle one on first with "t".')); continue; }
      const pick = ((await ask(`  default brain [${enabled.join('/')}]: `)) ?? '').trim() as BrainId;
      if (enabled.includes(pick)) { cfg.defaultBrain = pick; console.log(c.green(`  default set to ${cfg.brains[pick].label}`)); }
      else console.log(c.dim('  unchanged.'));
    } else if (choice === 't') {
      const pick = ((await ask(`  toggle which brain [${BRAIN_IDS.join('/')}]: `)) ?? '').trim() as BrainId;
      if (BRAIN_IDS.includes(pick)) {
        if (!cfg.brains[pick].enabled && !isInstalled(cfg.brains[pick].command)) {
          console.log(c.dim(`  ${cfg.brains[pick].label} is not installed. Run "holt init" to install it.`));
        } else {
          cfg.brains[pick].enabled = !cfg.brains[pick].enabled;
          if (!cfg.brains[pick].enabled && cfg.defaultBrain === pick) cfg.defaultBrain = BRAIN_IDS.find((id) => cfg.brains[id].enabled) ?? null;
          if (cfg.brains[pick].enabled && !cfg.defaultBrain) cfg.defaultBrain = pick;
          console.log(c.dim(`  ${cfg.brains[pick].label} is now ${cfg.brains[pick].enabled ? 'on' : 'off'}.`));
        }
      } else console.log(c.dim('  unchanged.'));
    } else if (choice === 'a') {
      const name = ((await ask('  launch command (blank to reset to holt): ')) ?? '').trim();
      if (name && name !== 'holt') {
        if (isInstalled(name)) console.log(c.dim(`  note: "${name}" already exists; the alias will shadow it in new shells.`));
        const r = installAlias(name);
        console.log(r.ok ? c.green(`  alias "${name}" -> holt chat added to ${r.file} (run: source ${r.file})`) : c.red('  ' + r.message));
      } else {
        removeAlias();
        console.log(c.dim('  reset to holt.'));
      }
    } else {
      console.log(c.dim('  pick d, t, a, or press enter to finish.'));
    }
    saveConfig(cfg);
  }
  saveConfig(cfg);
  return cfg;
}

/** `holt setting` entry point. */
export async function setting(): Promise<void> {
  const { ask, close } = createReader();
  if (!(await ensureTrusted(ask))) { close(); return; }
  await runSettings(ask);
  close();
  console.log('');
}
