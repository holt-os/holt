import { loadConfig, saveConfig, defaultConfig, BRAIN_IDS, type HoltConfig, type BrainId } from '../config';
import { isInstalled } from '../brains';
import { installAlias, removeAlias } from '../alias';
import { c, createReader, type Ask } from '../ui';

function printStatus(cfg: HoltConfig): void {
  console.log('\n' + c.accent('Holt settings'));
  for (const id of BRAIN_IDS) {
    const b = cfg.brains[id];
    const tags = [
      b.enabled ? c.green('installed') : c.dim('not found'),
      cfg.defaultBrain === id ? c.accent('default') : '',
    ].filter(Boolean).join('  ');
    console.log(`  ${id.padEnd(7)} ${b.label.padEnd(16)} ${tags}`);
  }
  console.log(c.dim(`  launch command: ${cfg.alias || 'holt (default)'}`));
  console.log('\n  ' + c.dim('[d] default brain   [a] launch command   [r] re-detect   [enter] done'));
}

/** Interactive settings loop. Reuses a caller-provided prompt so it can run inside chat. */
export async function runSettings(ask: Ask): Promise<HoltConfig> {
  let cfg = loadConfig() ?? defaultConfig();
  while (true) {
    for (const id of BRAIN_IDS) cfg.brains[id].enabled = isInstalled(cfg.brains[id].command);
    printStatus(cfg);
    const raw = await ask('  > ');
    const choice = (raw ?? '').trim().toLowerCase();
    if (raw === null || choice === '' || choice === 'q') break;

    if (choice === 'd') {
      const enabled = BRAIN_IDS.filter((id) => cfg.brains[id].enabled);
      if (enabled.length === 0) { console.log(c.dim('  No installed brains to choose from.')); continue; }
      const pick = ((await ask(`  default brain [${enabled.join('/')}]: `)) ?? '').trim() as BrainId;
      if (enabled.includes(pick)) { cfg.defaultBrain = pick; console.log(c.green(`  default set to ${cfg.brains[pick].label}`)); }
      else console.log(c.dim('  unchanged.'));
    } else if (choice === 'a') {
      const name = ((await ask('  launch command (blank to reset to holt): ')) ?? '').trim();
      if (name && name !== 'holt') {
        if (isInstalled(name)) console.log(c.dim(`  note: "${name}" already exists; the alias will shadow it in new shells.`));
        const r = installAlias(name);
        if (r.ok) { cfg.alias = name; console.log(c.green(`  alias "${name}" -> holt chat added to ${r.file}`)); console.log(c.dim(`  run: source ${r.file}  (or open a new terminal)`)); }
        else console.log(c.red('  ' + r.message));
      } else {
        const r = removeAlias();
        cfg.alias = null;
        console.log(c.dim(`  reset to holt.${r.ok ? '' : ' (' + r.message + ')'}`));
      }
    } else if (choice === 'r') {
      // re-detect happens at the top of the loop
    } else {
      console.log(c.dim('  pick d, a, r, or press enter to finish.'));
    }
    saveConfig(cfg);
  }
  saveConfig(cfg);
  return cfg;
}

/** `holt setting` entry point. */
export async function setting(): Promise<void> {
  const { ask, close } = createReader();
  await runSettings(ask);
  close();
  console.log('');
}
