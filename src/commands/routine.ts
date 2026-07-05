/**
 * `holt routine ...`: named, reusable, optionally scheduled jobs. A routine is
 * the bundle Holt was missing -- a task source (an installed skill or an inline
 * prompt) + an optional daily schedule + output routing (stdout / a file /
 * Telegram). It is the generic version of an AIOS "agent".
 *
 * Sources are resolved at run time: a skill's Markdown body becomes the prompt
 * (via loadSkill/resolveSkillInvocation), or the inline task is used directly.
 * Execution goes through the shared runTask engine, so a routine run behaves
 * exactly like `holt run`. A routine with `--at` also installs an OS timer
 * (reusing the scheduler) that fires `holt routine run <name> --quiet`.
 *
 * Trust-gated like every command that runs a task in a folder. Scheduled runs
 * are non-interactive: `holt routine run` auto-behaves like `holt run` under a
 * non-TTY (refuses cleanly if the folder is untrusted).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensureTrusted, isTrusted, workspace } from '../workspace';
import { c, createReader } from '../ui';
import { runTask } from '../runner';
import { loadSkill } from '../skills';
import { loadTelegramConfig, sendMessage } from '../telegram';
import {
  type Routine,
  type RoutineSource,
  sanitizeRoutineName,
  loadRoutines,
  findRoutine,
  upsertRoutine,
  removeRoutine,
  ROUTINE_TEMPLATES,
  templateNames,
} from '../routines';
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
} from '../scheduler';

// ---- schedule bridge (a routine with a time owns a scheduler Job) ----------

/**
 * Build the scheduler Job for a routine with a schedule. The Job's runArgs make
 * buildCommand emit `holt routine run <name> --quiet`, which routes its own
 * output; we key the Job id off the routine name so it is stable and easy to
 * find/remove without a separate lookup table.
 */
function jobForRoutine(r: Routine): Job {
  return {
    id: routineJobId(r.name),
    name: `routine:${r.name}`,
    task: r.source.kind === 'task' ? r.source.value : `skill:${r.source.value}`,
    when: r.when as string,
    workspace: r.workspace,
    notify: r.notify,
    ...(r.brain ? { brain: r.brain } : {}),
    runArgs: ['routine', 'run', r.name],
  };
}

/** Deterministic scheduler id for a routine's timer. */
function routineJobId(name: string): string {
  return `routine-${sanitizeRoutineName(name)}`;
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

/** Install the OS timer for a routine (idempotent: strips any prior one first). */
function installSchedule(r: Routine): void {
  const holtPath = resolveHoltPath();
  const job = jobForRoutine(r);
  // Replace any existing scheduler entry for this routine so re-adds are clean.
  removeSchedule(r.name);
  addJob(job);

  if (process.platform === 'darwin') installDarwin(job, holtPath);
  else if (process.platform === 'linux') installLinux(job, holtPath);
  else {
    console.log(c.dim('\n  Your OS has no built-in installer. Install this entry yourself:'));
    console.log('  ' + buildCronLine(job, holtPath));
  }
}

function removeScheduleDarwin(id: string): void {
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

function removeScheduleLinux(id: string): void {
  const body = currentCrontab();
  const next = stripCronLines(body, id);
  writeCrontab(next);
}

/** Remove a routine's OS timer + its scheduler store entry, if any. */
function removeSchedule(name: string): void {
  const id = routineJobId(name);
  const existed = loadJobs().some((j) => j.id === id);
  removeJob(id);
  if (!existed) return;
  if (process.platform === 'darwin') removeScheduleDarwin(id);
  else if (process.platform === 'linux') removeScheduleLinux(id);
}

// ---- arg parsing -----------------------------------------------------------

interface AddOpts {
  skill?: string;
  task?: string;
  template?: string;
  when?: string;
  notify: boolean;
  out?: string;
  brain?: string;
}

/** Parse `add` flags. First bare positional (before flags) is the name. */
function parseAdd(rest: string[]): { name?: string; opts: AddOpts } {
  const opts: AddOpts = { notify: false };
  let name: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '--notify') opts.notify = true;
    else if (a === '--skill') opts.skill = rest[++i];
    else if (a === '--task') opts.task = rest[++i];
    else if (a === '--template') opts.template = rest[++i];
    else if (a === '--at') opts.when = rest[++i];
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--brain') opts.brain = rest[++i];
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        if (k === 'skill') opts.skill = v;
        else if (k === 'task') opts.task = v;
        else if (k === 'template') opts.template = v;
        else if (k === 'at') opts.when = v;
        else if (k === 'out') opts.out = v;
        else if (k === 'brain') opts.brain = v;
      }
    } else if (name === undefined) name = a;
  }
  return { name, opts };
}

// ---- add -------------------------------------------------------------------

async function addCmd(rest: string[]): Promise<void> {
  const { name: rawName, opts } = parseAdd(rest);
  const name = sanitizeRoutineName(rawName || '');
  if (!name) {
    usage();
    process.exitCode = 1;
    return;
  }

  // Resolve the source: --template, else --skill, else --task. Exactly one.
  let source: RoutineSource;
  let when = opts.when;
  let notify = opts.notify;

  if (opts.template) {
    const tpl = ROUTINE_TEMPLATES[opts.template];
    if (!tpl) {
      console.error(
        '\n  ' +
          c.red(`Unknown template "${opts.template}".`) +
          c.dim(` Available: ${templateNames().join(', ')}`) +
          '\n',
      );
      process.exitCode = 1;
      return;
    }
    source = { ...tpl.source };
    // Explicit flags override the template's defaults.
    if (when === undefined) when = tpl.when;
    if (!opts.notify) notify = tpl.notify;
  } else if (opts.skill !== undefined && opts.task !== undefined) {
    console.error('\n  ' + c.red('Give either --skill or --task, not both.') + '\n');
    process.exitCode = 1;
    return;
  } else if (opts.skill !== undefined) {
    const loaded = loadSkill(opts.skill);
    if (!loaded) {
      console.error('\n  ' + c.red(`No skill named "${opts.skill}".`) + c.dim(' Try "holt skill list".') + '\n');
      process.exitCode = 1;
      return;
    }
    source = { kind: 'skill', value: loaded.skill.name };
  } else if (opts.task !== undefined && opts.task.trim()) {
    source = { kind: 'task', value: opts.task.trim() };
  } else {
    console.error('\n  ' + c.red('A routine needs a source: give --skill <s>, --task "<p>", or --template <t>.') + '\n');
    process.exitCode = 1;
    return;
  }

  if (when !== undefined) {
    try {
      parseWhen(when);
    } catch (e) {
      console.error('\n  ' + c.red((e as Error).message) + '\n');
      process.exitCode = 1;
      return;
    }
  }

  const routine: Routine = {
    name,
    source,
    notify,
    workspace: workspace(),
    ...(when !== undefined ? { when } : {}),
    ...(opts.out ? { out: opts.out } : {}),
    ...(opts.brain ? { brain: opts.brain } : {}),
  };

  upsertRoutine(routine);
  if (routine.when) installSchedule(routine);

  console.log('\n' + c.accent('Routine saved.'));
  printRoutine(routine, '  ');
  if (!routine.when) console.log(c.dim(`\n  Run it with:  holt routine run ${routine.name}`));
  console.log('');
}

// ---- run -------------------------------------------------------------------

/** Build the prompt a routine sends to the brain, resolving its source. */
function buildRoutinePrompt(r: Routine): { prompt: string } | { error: string } {
  if (r.source.kind === 'task') return { prompt: r.source.value };
  // Skill source: splice the skill body, mirroring resolveSkillInvocation.
  const loaded = loadSkill(r.source.value);
  if (!loaded) return { error: `Skill "${r.source.value}" is no longer installed. Try "holt skill list".` };
  const prompt = [
    loaded.body,
    '',
    'Apply the skill above to this request:',
    'Run this skill now for the current folder.',
  ].join('\n');
  return { prompt };
}

async function runCmd(rest: string[]): Promise<void> {
  // Run-time flags layer over the stored routine: --out and --notify add output
  // routing for this run; --brain overrides the brain; --quiet suppresses
  // stdout (what the scheduler passes).
  let quiet = false;
  let outOverride: string | undefined;
  let notifyOverride = false;
  let brainOverride: string | undefined;
  let name = '';
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '--quiet') quiet = true;
    else if (a === '--notify') notifyOverride = true;
    else if (a === '--out') outOverride = rest[++i];
    else if (a === '--brain') brainOverride = rest[++i];
    else if (!a.startsWith('--') && !name) name = sanitizeRoutineName(a);
  }
  if (!name) {
    console.log(c.dim('\n  Usage: holt routine run <name> [--quiet] [--out <file>] [--notify] [--brain <id>]\n'));
    process.exitCode = 1;
    return;
  }

  const routine = findRoutine(name);
  if (!routine) {
    process.stderr.write(c.red(`No routine named "${name}". See "holt routine list".`) + '\n');
    process.exitCode = 1;
    return;
  }

  // Trust gate, matching `holt run`: ask on a TTY, refuse cleanly otherwise.
  if (!isTrusted()) {
    if (process.stdin.isTTY) {
      const { ask, close } = createReader();
      const ok = await ensureTrusted(ask);
      close();
      if (!ok) return;
    } else {
      process.stderr.write('This folder is not trusted. Run holt init or holt chat here once, then run the routine.\n');
      process.exitCode = 1;
      return;
    }
  }

  const built = buildRoutinePrompt(routine);
  if ('error' in built) {
    process.stderr.write(c.red(built.error) + '\n');
    process.exitCode = 1;
    return;
  }

  const brainId = brainOverride ?? routine.brain;
  const outTarget = outOverride ?? routine.out;
  const wantNotify = notifyOverride || routine.notify;

  let streamed = false;
  const result = await runTask(built.prompt, {
    ...(brainId ? { brainId } : {}),
    onChunk: quiet ? undefined : (ch) => { streamed = true; process.stdout.write(ch); },
  });

  if (!result.ok) {
    if (streamed) process.stdout.write('\n');
    process.stderr.write(c.red(result.text) + '\n');
    process.exitCode = 1;
    return;
  }

  // stdout (only when not quiet and nothing was streamed live).
  if (!quiet && !streamed) process.stdout.write(result.text);
  if (!quiet && (streamed || result.text) && !result.text.endsWith('\n')) process.stdout.write('\n');

  // --out: write the result, tolerating a failure cleanly.
  if (outTarget) {
    const target = resolve(routine.workspace, outTarget);
    try {
      writeFileSync(target, result.text, 'utf8');
      if (!quiet) process.stderr.write(c.dim(`saved to ${target}`) + '\n');
    } catch (e) {
      process.stderr.write(c.red(`Could not write ${target}: ${(e as Error).message}`) + '\n');
      process.exitCode = 1;
    }
  }

  // --notify: push the result to Telegram, guarding when it is not configured.
  if (wantNotify) {
    if (!loadTelegramConfig()) {
      process.stderr.write(c.dim('Telegram is not set up; skipping notify. Run "holt telegram setup".') + '\n');
    } else {
      const sent = await sendMessage(result.text);
      if (!sent) process.stderr.write(c.dim('Could not push the result to Telegram.') + '\n');
    }
  }
}

// ---- list / show / remove --------------------------------------------------

function sourceLabel(s: RoutineSource): string {
  return s.kind === 'skill' ? `skill:${s.value}` : `task: ${s.value.length > 46 ? s.value.slice(0, 45) + '…' : s.value}`;
}

function outputsLabel(r: Routine): string {
  const outs: string[] = [];
  if (r.notify) outs.push('notify');
  if (r.out) outs.push(`out:${r.out}`);
  if (outs.length === 0) outs.push('stdout');
  return outs.join(' ');
}

function listCmd(): void {
  const routines = loadRoutines();
  if (routines.length === 0) {
    console.log(c.dim('\n  No routines yet. Add one with:'));
    console.log(c.dim('  holt routine add <name> (--skill <s> | --task "<p>") [--at HH:MM] [--notify] [--out <file>]\n'));
    return;
  }
  console.log('\n' + c.accent('Routines'));
  for (const r of routines) {
    const sched = r.when ? `daily ${r.when}` : 'manual';
    console.log(`  ${c.bold(r.name)}  ${c.dim(sched)}  ${c.dim(outputsLabel(r))}`);
    console.log(c.dim(`      ${sourceLabel(r.source)}`));
    console.log(c.dim(`      ${r.workspace}`));
  }
  console.log(c.dim('\n  holt routine show <name>   full detail'));
  console.log(c.dim('  holt routine run <name>    run it now\n'));
}

function printRoutine(r: Routine, pad: string): void {
  console.log(`${pad}name       ${r.name}`);
  console.log(`${pad}source     ${sourceLabel(r.source)}`);
  console.log(`${pad}schedule   ${r.when ? `daily at ${r.when}` : 'manual (run on demand)'}`);
  console.log(`${pad}outputs    ${outputsLabel(r)}`);
  if (r.brain) console.log(`${pad}brain      ${r.brain}`);
  console.log(`${pad}workspace  ${r.workspace}`);
}

function showCmd(rest: string[]): void {
  const name = sanitizeRoutineName(rest.find((a) => !a.startsWith('--')) || '');
  if (!name) {
    console.log(c.dim('\n  Usage: holt routine show <name>\n'));
    process.exitCode = 1;
    return;
  }
  const r = findRoutine(name);
  if (!r) {
    console.error(c.dim(`\n  No routine named "${name}". See "holt routine list".\n`));
    process.exitCode = 1;
    return;
  }
  console.log('\n' + c.accent(r.name));
  printRoutine(r, '  ');
  if (r.source.kind === 'task') {
    console.log(c.dim('\n  task:'));
    console.log('  ' + r.source.value);
  }
  console.log('');
}

function removeCmd(rest: string[]): void {
  const name = sanitizeRoutineName(rest.find((a) => !a.startsWith('--')) || '');
  if (!name) {
    console.log(c.dim('\n  Usage: holt routine remove <name>\n'));
    process.exitCode = 1;
    return;
  }
  const existed = loadRoutines().some((r) => r.name === name);
  removeSchedule(name); // strips the OS timer + scheduler store entry, if any
  removeRoutine(name);
  if (existed) console.log('\n' + c.green(`  Removed routine ${name}.`) + '\n');
  else {
    console.error(c.dim(`\n  No routine named "${name}". Nothing to remove.\n`));
    process.exitCode = 1;
  }
}

// ---- usage + dispatch ------------------------------------------------------

function usage(): void {
  console.log('\n' + c.accent('holt routine') + c.dim('  named, reusable, scheduled jobs'));
  console.log(c.dim('\n  holt routine add <name> (--skill <s> | --task "<p>") [--at HH:MM] [--notify] [--out <file>] [--brain <id>]'));
  console.log(c.dim('  holt routine add <name> --template <t>' + `   (templates: ${templateNames().join(', ')})`));
  console.log(c.dim('  holt routine run <name> [--quiet]'));
  console.log(c.dim('  holt routine list'));
  console.log(c.dim('  holt routine show <name>'));
  console.log(c.dim('  holt routine remove <name>'));
  console.log(c.dim('\n  A routine = a task source (skill or inline prompt) + an optional daily'));
  console.log(c.dim('  schedule + output routing (stdout, --out file, or --notify to Telegram).\n'));
}

/** `holt routine [add|run|list|show|remove] ...` */
export async function routine(sub?: string, rest: string[] = []): Promise<void> {
  const action = (sub || '').toLowerCase();

  // Read-only subcommands never touch the system or run a task, so they skip the
  // trust gate (and never block on a prompt non-interactively).
  if (action === 'list' || action === 'ls') {
    listCmd();
    return;
  }
  if (action === 'show' || action === 'view') {
    showCmd(rest);
    return;
  }
  if (!action) {
    usage();
    listCmd();
    return;
  }

  // `run` handles its own trust gate (interactive ask vs non-interactive refuse)
  // so scheduled runs work under launchd/cron without hanging.
  if (action === 'run') {
    await runCmd(rest);
    return;
  }

  if (action !== 'add' && action !== 'remove' && action !== 'rm') {
    process.exitCode = 1; // explicit but unknown subcommand is an error
    usage();
    return;
  }

  // Mutating subcommands write routine + launchd/cron entries that run in this
  // workspace, so they require trust first.
  const { ask, close } = createReader();
  if (!(await ensureTrusted(ask))) {
    close();
    return;
  }
  close();

  if (action === 'add') await addCmd(rest);
  else removeCmd(rest);
}
