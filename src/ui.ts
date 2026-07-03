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
