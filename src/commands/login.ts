import { BRAIN_IDS, BRAIN_DEFS, BRAIN_SETUP, type BrainId } from '../config';
import { runInteractive } from '../install';
import { c } from '../ui';

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
  const s = BRAIN_SETUP[id];
  console.log('\n' + c.accent(`Sign in to ${BRAIN_DEFS[id].label}`));
  console.log(c.dim(`  Starting "${s.login.join(' ')}". Complete sign-in, then exit that tool.\n`));
  await runInteractive(s.login[0] as string, s.login.slice(1));
}
