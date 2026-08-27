import {
  BRAIN_IDS,
  BRAIN_DEFS,
  BRAIN_SETUP,
  loginUnavailable,
  cliBrainUsable,
  PROVIDER_ENV,
  loadConfig,
  saveConfig,
  type BrainId,
  type HoltConfig,
  type LoginUnavailable,
} from '../config';
import { runInteractive } from '../install';
import { connectApiBrain } from './setting';
import { c, createReader, askYesNo, type Ask } from '../ui';

/**
 * Explain that a brain's interactive sign-in is gone and what to do instead.
 * Shared by `holt login`, `/login` in chat, and `holt init`, so the user reads
 * the same story wherever they hit the dead end.
 */
export function printLoginUnavailable(id: BrainId, info: LoginUnavailable): void {
  console.log('\n' + c.red(`${BRAIN_DEFS[id].label} sign-in is no longer available.`));
  console.log(c.dim('  ' + info.reason));
  console.log('\n  It still works on an API key. Two ways:');
  console.log('    1. ' + c.accent(`Get a key at ${info.keyUrl}`));
  console.log('    2. Either export it as ' + c.accent(`${info.provider.toUpperCase()}_API_KEY`)
    + c.dim(` (the ${BRAIN_DEFS[id].command} CLI reads it too), or connect it to Holt as a direct API brain.`));
}

/**
 * Offer the API-key route after a dead sign-in. Returns true if a brain was
 * connected. Needs a config to write into, so it no-ops in an un-init'd folder.
 */
export async function offerKeyInstead(ask: Ask, id: BrainId, info: LoginUnavailable): Promise<boolean> {
  const cfg: HoltConfig | null = loadConfig();
  if (!cfg) {
    console.log(c.dim('\n  This folder is not set up yet. Run "holt init" and connect it as a direct API brain.\n'));
    return false;
  }
  if (!(await askYesNo(ask, `\n  Connect ${BRAIN_DEFS[id].label} to Holt with an API key now? [Y/n] `, true))) {
    console.log(c.dim('  Okay. Run "holt setting" then "c" whenever you have the key.\n'));
    return false;
  }
  const brain = await connectApiBrain(ask, cfg, info.provider);
  if (!brain) return false;
  // The user came here trying to use this brain, so point the folder at the
  // replacement rather than leaving them on a brain they cannot sign in to.
  if (!cfg.defaultBrain || cfg.defaultBrain === id) {
    cfg.defaultBrain = brain.id;
    console.log(c.dim(`  default brain for this folder is now "${brain.id}".`));
  }
  // The CLI brain cannot be signed in to, so stop offering it as a chat target.
  if (cfg.brains[id]?.enabled) {
    cfg.brains[id].enabled = false;
    console.log(c.dim(`  turned off the ${BRAIN_DEFS[id].label} brain (no sign-in available).`));
  }
  saveConfig(cfg);
  console.log(c.green('\n  Done. Start Holt: holt\n'));
  return true;
}

/** `holt login <brain>`: hand off to a brain CLI's own sign-in. */
export async function login(which?: string): Promise<void> {
  const id = (which || '').toLowerCase() as BrainId;
  if (!(BRAIN_IDS as string[]).includes(id)) {
    if (which) {
      console.error(`\n  Unknown brain "${which}". Use one of: ${BRAIN_IDS.join(', ')}\n`);
      process.exitCode = 1;
    } else {
      console.log(c.dim(`\n  Usage: holt login <${BRAIN_IDS.join('|')}>\n`));
    }
    return;
  }

  // Some brains no longer have an interactive sign-in at all. Launching their
  // CLI would just show the user a dead-end error, so explain and route to a key.
  const gone = loginUnavailable(id);
  if (gone) {
    printLoginUnavailable(id, gone);
    // The key is already in the environment, so the CLI itself still works and
    // there is nothing for the user to connect. Say so instead of prompting.
    if (cliBrainUsable(id)) {
      console.log(c.green(`\n  ${PROVIDER_ENV[gone.provider]} is already set, so ${BRAIN_DEFS[id].label} works as it is. Nothing to do.\n`));
      return;
    }
    const { ask, close } = createReader();
    await offerKeyInstead(ask, id, gone);
    close();
    return;
  }

  const s = BRAIN_SETUP[id];
  console.log('\n' + c.accent(`Sign in to ${BRAIN_DEFS[id].label}`));
  console.log(c.dim(`  Starting "${s.login.join(' ')}". Complete sign-in, then exit that tool.\n`));
  await runInteractive(s.login[0] as string, s.login.slice(1));
}
