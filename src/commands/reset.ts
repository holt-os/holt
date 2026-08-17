/**
 * `holt reset`: a safe start-over for this folder. Deletes the folder's Holt
 * state (settings and memory) after an explicit typed confirmation, and says
 * exactly what will go. Knowing a clean exit exists is part of what makes a
 * non-technical user comfortable experimenting.
 */
import { existsSync, rmSync } from 'node:fs';
import { wsHoltDir, workspace } from '../workspace';
import { memStats } from '../memory';
import { c, createReader } from '../ui';

export async function reset(): Promise<void> {
  const { ask, close } = createReader();
  try {
    const dir = wsHoltDir();
    if (!existsSync(dir)) {
      console.log(c.dim('\n  Nothing to reset: Holt has no settings or memory in this folder.\n'));
      return;
    }
    let turns = 0;
    try {
      turns = memStats().turns;
    } catch {
      // A damaged memory store is exactly when reset is most needed.
    }
    console.log('\n' + c.bold('Reset Holt in this folder'));
    console.log(c.dim(`  Folder: ${workspace()}`));
    console.log(c.dim(`  This deletes Holt's settings and all ${turns} remembered moment${turns === 1 ? '' : 's'} here.`));
    console.log(c.dim('  Your own files are not touched. Other folders are not touched.'));
    const a = ((await ask(`\n  Type ${c.bold('reset')} to confirm, or press enter to cancel: `)) ?? '').trim().toLowerCase();
    if (a !== 'reset') {
      console.log(c.dim('  Cancelled. Nothing was changed.\n'));
      return;
    }
    rmSync(dir, { recursive: true, force: true });
    console.log(c.green('\n  Done. This folder is a clean slate.') + c.dim('  Run "holt" to set it up again.\n'));
  } finally {
    close();
  }
}
