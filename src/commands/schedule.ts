/**
 * `holt schedule ...`: run a Holt task automatically on a timer. Trust-gated
 * like `holt memory`. On macOS this installs a launchd plist; on Linux it adds
 * a line to your crontab. Both invoke the `holt` binary at the scheduled time,
 * so a scheduled run behaves exactly like typing `holt run` yourself.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureTrusted, workspace } from '../workspace';
import { c, createReader } from '../ui';
import {
  type Job,
  parseWhen,
  loadJobs,
  addJob,
  removeJob,
  newJobId,
  resolveHoltPath,
  buildLaunchdPlist,
  buildCronLine,
  stripCronLines,
  appendCronLine,
  plistPath,
  logPath,
  ensureLogsDir,
} from '../scheduler';

interface AddOpts {
  name?: string;
  notify: boolean;
  brain?: string;
}

/** Split `add` positionals/flags: first bare token is the task, second is when. */
function parseAdd(rest: string[]): { task?: string; when?: string; opts: AddOpts } {
  const positional: string[] = [];
  const opts: AddOpts = { notify: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--notify') opts.notify = true;
    else if (a === '--name') opts.name = rest[++i];
    else if (a === '--brain') opts.brain = rest[++i];
    else if (a && a.startsWith('--')) {
      // tolerate `--flag=value`
      const eq = a.indexOf('=');
      if (eq > 2) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        if (k === 'name') opts.name = v;
        else if (k === 'brain') opts.brain = v;
      }
    } else if (a !== undefined) positional.push(a);
  }
  return { task: positional[0], when: positional[1], opts };
}

function installDarwin(job: Job, holtPath: string): void {
  const path = plistPath(job.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildLaunchdPlist(job, holtPath), 'utf8');
  const res = spawnSync('launchctl', ['load', '-w', path], { encoding: 'utf8' });
  if (res.status === 0) {
    console.log(c.green('  Loaded into launchd.'));
  } else {
    console.log(c.dim('  Wrote the plist, but launchctl load did not confirm.'));
    console.log(c.dim(`  Load it yourself with:  launchctl load -w ${path}`));
    if (res.stderr && res.stderr.trim()) console.log(c.dim(`  (${res.stderr.trim()})`));
  }
  console.log(c.dim(`  plist: ${path}`));
}

function currentCrontab(): string {
  const res = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  return res.status === 0 && typeof res.stdout === 'string' ? res.stdout : '';
}

function writeCrontab(body: string): boolean {
  const res = spawnSync('crontab', ['-'], { input: body, encoding: 'utf8' });
  return res.status === 0;
}

function installLinux(job: Job, holtPath: string): void {
  const line = buildCronLine(job, holtPath);
  const next = appendCronLine(currentCrontab(), line);
  if (writeCrontab(next)) {
    console.log(c.green('  Added to your crontab.'));
    console.log(c.dim(`  line: ${line}`));
  } else {
    console.log(c.dim('  Could not update the crontab automatically. Add this line yourself:'));
    console.log('  ' + line);
  }
}

async function addCmd(rest: string[]): Promise<void> {
  const { task, when, opts } = parseAdd(rest);
  if (!task || !when) {
    console.log(c.dim('\n  Usage: holt schedule add "<task>" <HH:MM> [--name <n>] [--notify] [--brain <id>]\n'));
    return;
  }
  try {
    parseWhen(when);
  } catch (e) {
    console.log('\n  ' + c.red((e as Error).message) + '\n');
    return;
  }

  const ws = workspace();
  const holtPath = resolveHoltPath();
  const job: Job = {
    id: newJobId(),
    name: opts.name || task.slice(0, 40),
    task,
    when,
    workspace: ws,
    notify: opts.notify,
    ...(opts.brain ? { brain: opts.brain } : {}),
  };

  ensureLogsDir();
  addJob(job);

  console.log('\n' + c.accent('Scheduled.'));
  console.log(`  id         ${job.id}`);
  console.log(`  when       daily at ${job.when}`);
  console.log(`  workspace  ${job.workspace}`);
  if (job.notify) console.log(`  notify     on (pushes output to Telegram)`);
  console.log(`  log        ${logPath(job.id)}`);

  if (process.platform === 'darwin') installDarwin(job, holtPath);
  else if (process.platform === 'linux') installLinux(job, holtPath);
  else {
    console.log(c.dim('\n  Your OS has no built-in installer. Install this entry yourself:'));
    console.log('  ' + buildCronLine(job, holtPath));
  }
  console.log('');
}

function listCmd(): void {
  const jobs = loadJobs();
  if (jobs.length === 0) {
    console.log(c.dim('\n  No scheduled tasks yet. Add one with:'));
    console.log(c.dim('  holt schedule add "<task>" <HH:MM> [--notify]\n'));
    return;
  }
  console.log('\n' + c.accent('Scheduled tasks'));
  for (const j of jobs) {
    console.log(`  ${c.bold(j.id)}  daily ${j.when}  ${c.dim(j.notify ? '(notify)' : '')}`);
    console.log(`      ${j.name}`);
    console.log(c.dim(`      ${j.workspace}`));
  }
  console.log('');
}

function removeDarwin(id: string): void {
  const path = plistPath(id);
  if (existsSync(path)) {
    spawnSync('launchctl', ['unload', path], { encoding: 'utf8' });
    try {
      rmSync(path);
    } catch {
      // ignore
    }
  }
}

function removeLinux(id: string): void {
  const res = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  const body = res.status === 0 && typeof res.stdout === 'string' ? res.stdout : '';
  const next = stripCronLines(body, id);
  spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
}

function removeCmd(rest: string[]): void {
  const id = rest[0];
  if (!id) {
    console.log(c.dim('\n  Usage: holt schedule remove <id>   (see ids with: holt schedule list)\n'));
    return;
  }
  const before = loadJobs();
  const existed = before.some((j) => j.id === id);
  removeJob(id);

  if (process.platform === 'darwin') removeDarwin(id);
  else if (process.platform === 'linux') removeLinux(id);

  if (existed) console.log('\n' + c.green(`  Removed schedule ${id}.`) + '\n');
  else console.log(c.dim(`\n  No schedule with id ${id}. Nothing to remove.\n`));
}

function usage(): void {
  console.log('\n' + c.accent('holt schedule') + c.dim('  run a task automatically on a timer'));
  console.log(c.dim('\n  holt schedule add "<task>" <HH:MM> [--name <n>] [--notify] [--brain <id>]'));
  console.log(c.dim('  holt schedule list'));
  console.log(c.dim('  holt schedule remove <id>\n'));
}

/** `holt schedule [add|list|remove] ...` */
export async function schedule(sub?: string, rest: string[] = []): Promise<void> {
  const action = (sub || '').toLowerCase();

  // Read-only subcommands never touch the system or the workspace, so they run
  // without the trust gate (and without blocking on a prompt non-interactively).
  if (action === 'list') {
    listCmd();
    return;
  }
  if (action !== 'add' && action !== 'remove' && action !== 'rm') {
    usage();
    return;
  }

  // Mutating subcommands write launchd/cron entries that run in this workspace,
  // so they require trust first.
  const { ask, close } = createReader();
  if (!(await ensureTrusted(ask))) {
    close();
    return;
  }
  close();

  if (action === 'add') await addCmd(rest);
  else removeCmd(rest);
}
