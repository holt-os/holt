import { loadConfig, saveConfig, defaultConfig, BRAIN_IDS, type BrainId } from '../config';
import { isInstalled } from '../brains';
import { installAlias } from '../alias';
import { c, createReader } from '../ui';

/** `holt init`: detect agent CLIs, pick a default brain, set an optional launch command. */
export async function init(): Promise<void> {
  const { ask, close } = createReader();
  const cfg = loadConfig() ?? defaultConfig();

  console.log('\n' + c.accent('Holt setup') + '\n');
  console.log('Looking for agent CLIs on your machine...\n');

  const found: BrainId[] = [];
  for (const id of BRAIN_IDS) {
    const b = cfg.brains[id];
    const ok = isInstalled(b.command);
    b.enabled = ok;
    console.log(`  ${ok ? c.green('found  ') : c.dim('missing')}  ${b.label} (${b.command})`);
    if (ok) found.push(id);
  }
  console.log('');

  if (found.length === 0) {
    console.log(c.dim('No agent CLIs found. Install one of: claude (Claude Code), codex, or gemini,'));
    console.log(c.dim('then run "holt init" again. You can still set a launch command below.\n'));
  } else {
    const def: BrainId = found.includes('claude') ? 'claude' : (found[0] as BrainId);
    const ans = ((await ask(`Default brain? [${found.join('/')}] (${def}): `)) ?? '').trim() as BrainId;
    cfg.defaultBrain = found.includes(ans) ? ans : def;
    console.log(c.dim(`  default brain: ${cfg.brains[cfg.defaultBrain].label}\n`));
  }

  const aliasAns = ((await ask('Launch command? Type a custom word like "ai", or press enter to keep "holt": ')) ?? '').trim();
  if (aliasAns && aliasAns !== 'holt') {
    if (isInstalled(aliasAns)) console.log(c.dim(`  note: "${aliasAns}" already exists on your system; the alias will shadow it in new shells.`));
    const r = installAlias(aliasAns);
    if (r.ok) {
      cfg.alias = aliasAns;
      console.log(c.green(`  alias "${aliasAns}" -> holt chat, added to ${r.file}`));
      console.log(c.dim(`  run: source ${r.file}   (or open a new terminal)`));
    } else {
      console.log(c.red('  ' + r.message));
    }
  } else {
    cfg.alias = null;
  }

  saveConfig(cfg);
  const launch = cfg.alias ? cfg.alias : 'holt chat';
  console.log('\n' + c.green('Saved to ~/.holt/config.json'));
  if (cfg.defaultBrain) console.log('Start chatting:  ' + c.accent(launch) + '\n');
  else console.log(c.dim('Install an agent CLI, run "holt init" again, then "holt chat".\n'));
  close();
}
