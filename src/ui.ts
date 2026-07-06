/** Tiny terminal helpers. No dependencies. */
import readline from 'node:readline';

const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  accent: wrap('38;5;214'), // amber
  green: wrap('32'),
  red: wrap('31'),
  cyan: wrap('36'),
};

/** A colored fill bar for a 0..1 fraction, e.g. green filled + dim remainder. */
export function bar(fraction: number, width = 12): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return c.green('█'.repeat(filled)) + c.dim('░'.repeat(width - filled));
}

/**
 * A sticky one-line status bar pinned to the last terminal row (Claude-Code
 * style). It uses a DEC scroll region so normal output (streamed replies,
 * command output, the readline prompt) scrolls in the rows ABOVE the bar and
 * never overwrites it. Plain ANSI, no dependencies.
 *
 * Guardrails:
 *  - TTY only. `create` returns an inert handle when stdout is not a TTY, so
 *    piped input, tests and CI keep the exact old behavior (no escape codes).
 *  - Coexists with readline WITHOUT patching stdout.write: the DEC scroll region
 *    physically protects the bar row, so the readline prompt/echo and streamed
 *    output scroll in rows 1..(r-1) and can never overwrite the bar on row r.
 *    (An earlier version repainted after every write; that interleaved cursor
 *    save/restore with readline's per-keystroke echo and corrupted typed input.
 *    Relying on the scroll region alone keeps the REPL clean.)
 *  - Redraws on SIGWINCH (resize) and whenever the bar text changes (`set`).
 *  - `detach()` resets the scroll region, clears the bar row, and restores the
 *    cursor to a sane, visible state.
 */
export interface StatusBar {
  /** True when a live sticky bar is active (TTY). False = inert fallback. */
  readonly active: boolean;
  /** Set the bar text (raw, may contain color escapes) and repaint. */
  set(text: string): void;
  /** Remove the bar and restore the terminal to a sane state. */
  detach(): void;
}

const CSI = '\x1b[';

export function createStatusBar(): StatusBar {
  const out = process.stdout;
  if (!out.isTTY) {
    return { active: false, set: () => {}, detach: () => {} };
  }

  let text = '';
  let detached = false;
  const realWrite = out.write.bind(out);

  const rows = (): number => out.rows || 24;

  // Draw the bar on the last row without disturbing the cursor the caller left
  // in the scroll region. Uses save/restore cursor (DECSC/DECRC).
  const paint = (): void => {
    if (detached) return;
    const r = rows();
    realWrite(
      `\x1b7` +               // save cursor
      `${CSI}${r};1H` +       // move to last row, col 1
      `${CSI}2K` +            // clear the line
      text +
      `\x1b8`,               // restore cursor
    );
  };

  // Reserve the bottom row: scroll region = rows 1..(r-1). Park the cursor just
  // above the bar so the first prompt/output lands correctly.
  const reserve = (): void => {
    const r = rows();
    realWrite(
      `${CSI}1;${Math.max(1, r - 1)}r` + // set scroll region (DECSTBM)
      `${CSI}${Math.max(1, r - 1)};1H`,  // move cursor into the region
    );
    paint();
  };

  const onResize = (): void => { if (!detached) reserve(); };

  const detach = (): void => {
    if (detached) return;
    detached = true;
    out.removeListener('resize', onResize);
    process.removeListener('exit', detach);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    const r = rows();
    realWrite(
      `${CSI}r` +          // reset scroll region to full screen
      `\x1b7` +
      `${CSI}${r};1H${CSI}2K` + // clear the bar row
      `\x1b8` +
      `${CSI}?25h`,        // ensure cursor visible
    );
  };

  // Safety net for abrupt exits (Ctrl-C, SIGTERM): restore the terminal, then
  // let the default signal behavior take over so the process still dies.
  const onSignal = (sig: NodeJS.Signals): void => {
    detach();
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };

  reserve();
  out.on('resize', onResize);
  process.once('exit', detach);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return {
    active: true,
    set(next: string): void {
      text = next;
      paint();
    },
    detach,
  };
}

/** Ask returns the line, or null on EOF (so loops can end). */
export type Ask = (q: string) => Promise<string | null>;

export interface Reader {
  ask: Ask;
  close: () => void;
}

/**
 * A single stdin reader that queues lines. This avoids the readline race where
 * sequential rl.question calls drop piped lines, and works interactively too.
 */
export function createReader(): Reader {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const buffer: string[] = [];
  const waiters: Array<(v: string | null) => void> = [];
  let closed = false;

  rl.on('line', (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else buffer.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) (waiters.shift() as (v: string | null) => void)(null);
  });

  const ask: Ask = (q) =>
    new Promise((resolve) => {
      if (q) process.stdout.write(q);
      if (buffer.length) resolve(buffer.shift() as string);
      else if (closed) resolve(null);
      else waiters.push(resolve);
    });

  return { ask, close: () => rl.close() };
}
