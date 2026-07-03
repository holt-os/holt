/**
 * `holt run <task>`: run a single task non-interactively against the configured
 * brain and stream the result. Wraps runTask from the shared engine. Useful for
 * one-shot prompts, scripting, and scheduled jobs.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTask } from '../runner';
import { isTrusted, ensureTrusted } from '../workspace';
import { c, createReader } from '../ui';

const USAGE = [
  '  holt run <task> [options]',
  '',
  '  Run a single task against your default brain and stream the reply.',
  '',
  '  options:',
  '    --brain <id>   use a specific brain (CLI or API brain id)',
  '    --out <file>   also write the reply to a file (relative to this folder)',
  '    --no-store     do not save this exchange to memory',
  '    --no-recall    do not pull memory into the prompt',
  '    --quiet        suppress streaming; still writes --out and sets exit code',
  '',
  '  example: holt run "summarize the open items in this folder"',
].join('\n');

interface Parsed {
  task: string;
  brainId?: string;
  out?: string;
  noStore: boolean;
  noRecall: boolean;
  quiet: boolean;
}

function parseArgs(args: string[]): Parsed {
  const words: string[] = [];
  let brainId: string | undefined;
  let out: string | undefined;
  let noStore = false;
  let noRecall = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--brain') { brainId = args[++i]; continue; }
    if (a === '--out') { out = args[++i]; continue; }
    if (a === '--no-store') { noStore = true; continue; }
    if (a === '--no-recall') { noRecall = true; continue; }
    if (a === '--quiet') { quiet = true; continue; }
    words.push(a);
  }

  return { task: words.join(' ').trim(), brainId, out, noStore, noRecall, quiet };
}

export async function run(args: string[]): Promise<void> {
  const p = parseArgs(args);

  if (!p.task) {
    console.log(USAGE);
    return;
  }

  // Trust gate. Interactively we can ask; non-interactively we refuse.
  if (!isTrusted()) {
    if (process.stdin.isTTY) {
      const { ask, close } = createReader();
      const ok = await ensureTrusted(ask);
      close();
      if (!ok) return;
    } else {
      process.stderr.write('This folder is not trusted. Run holt init or holt chat here once, then schedule/run.\n');
      process.exitCode = 1;
      return;
    }
  }

  let streamed = false;
  const result = await runTask(p.task, {
    brainId: p.brainId,
    recall: !p.noRecall,
    store: !p.noStore,
    onChunk: p.quiet ? undefined : (ch) => { streamed = true; process.stdout.write(ch); },
  });

  if (!p.quiet && !streamed) {
    process.stdout.write(result.text);
  }
  // Ensure a trailing newline after streamed or printed output.
  if (!p.quiet && (streamed || result.text) && !result.text.endsWith('\n')) {
    process.stdout.write('\n');
  }

  if (!result.ok) {
    process.stderr.write(c.red(result.text) + '\n');
    process.exitCode = 1;
    return;
  }

  if (p.out) {
    const target = resolve(process.cwd(), p.out);
    writeFileSync(target, result.text, 'utf8');
    process.stderr.write(c.dim(`saved to ${target}`) + '\n');
  }
}
