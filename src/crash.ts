/**
 * Last-resort crash handler. Any error no command caught lands here instead of
 * dumping a raw stack trace on the user. The full detail goes to a log file
 * (workspace .holt/logs when it exists, else ~/.holt/logs) and the user gets a
 * short note pointing at the log and at "holt doctor --fix".
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { wsHoltDir, GLOBAL_DIR } from './workspace';
import { c, isQuietMode } from './ui';
import { VERSION } from './version';

export function handleCrash(err: unknown): never {
  const stamp = new Date().toISOString();
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  let logPath: string | null = null;
  const entry = `[${stamp}] holt ${VERSION}  argv: ${process.argv.slice(2).join(' ')}\n${detail}\n\n`;
  // Prefer the workspace log dir, but the workspace itself may be what is
  // broken (e.g. ".holt" exists as a file), so always fall back to ~/.holt.
  for (const base of [wsHoltDir(), GLOBAL_DIR]) {
    try {
      const dir = join(base, 'logs');
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `crash-${stamp.slice(0, 10)}.log`);
      appendFileSync(p, entry, 'utf8');
      logPath = p;
      break;
    } catch {
      // Logging must never crash the crash handler; try the next location.
    }
  }
  if (!isQuietMode()) {
    console.error(c.red('\n  Something went wrong, and it is not your fault.'));
    if (logPath) console.error(c.dim(`  Details saved to: ${logPath}`));
    console.error(c.dim('  Try: holt doctor --fix   (it repairs the common causes)'));
    console.error(c.dim('  Still stuck? https://github.com/holt-os/holt/issues\n'));
  }
  process.exit(1);
}
