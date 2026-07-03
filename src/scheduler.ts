/**
 * Scheduler: run Holt tasks on a timer, the OS-native way. On macOS we emit a
 * launchd plist and load it with launchctl; on Linux we append a line to the
 * user crontab. All entry generation is PURE (buildLaunchdPlist / buildCronLine)
 * so it can be tested without touching the real launchd or crontab. A tiny JSON
 * store at ~/.holt/schedules.json is the source of truth for what we installed.
 *
 * The scheduled job never imports the runner; it shells out to the `holt`
 * binary: `holt run "<task>" --quiet --out <log>` and optionally pipes the log
 * into `holt notify`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { GLOBAL_DIR } from './workspace';

export interface Job {
  id: string;
  name: string;
  task: string;
  when: string; // as the user typed it, e.g. "07:00"
  workspace: string; // absolute path the task runs in
  notify: boolean;
  brain?: string;
}

export interface ParsedWhen {
  hour: number;
  minute: number;
}

// ---- paths ----

export function schedulesPath(): string {
  return join(GLOBAL_DIR, 'schedules.json');
}
export function logsDir(): string {
  return join(GLOBAL_DIR, 'logs');
}
export function logPath(id: string): string {
  return join(logsDir(), `${id}.log`);
}
export function plistPath(id: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `com.holt.${id}.plist`);
}

// ---- JSON store ----

export function loadJobs(): Job[] {
  try {
    const raw = JSON.parse(readFileSync(schedulesPath(), 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as Job[]) : [];
  } catch {
    return [];
  }
}

export function saveJobs(jobs: Job[]): void {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(schedulesPath(), JSON.stringify(jobs, null, 2) + '\n', 'utf8');
}

export function addJob(job: Job): Job[] {
  const jobs = loadJobs();
  jobs.push(job);
  saveJobs(jobs);
  return jobs;
}

export function removeJob(id: string): Job[] {
  const jobs = loadJobs().filter((j) => j.id !== id);
  saveJobs(jobs);
  return jobs;
}

export function newJobId(): string {
  return randomUUID().slice(0, 8);
}

// ---- time parsing ----

/**
 * Parse a schedule expression. This version supports daily "HH:MM" (24h) only.
 * Anything else throws with a clear message. (Raw 5-field cron is accepted by
 * the Linux install path directly, not here.)
 */
export function parseWhen(when: string): ParsedWhen {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(when.trim());
  if (!m) {
    throw new Error(
      `Could not read time "${when}". Use 24h HH:MM for a daily run, e.g. 07:00 or 23:30.`,
    );
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return { hour, minute };
}

// ---- shell escaping ----

/** Single-quote a string for POSIX sh, safe for any content. */
export function shQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

// ---- binary resolution ----

/** Resolve the holt binary path via `which holt`, falling back to "holt". */
export function resolveHoltPath(): string {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(finder, ['holt'], { encoding: 'utf8' });
    if (res.status === 0 && typeof res.stdout === 'string') {
      const first = res.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
      if (first) return first;
    }
  } catch {
    // ignore, fall through
  }
  return 'holt';
}

// ---- command building (shared) ----

/**
 * The core shell command a scheduled job runs: cd into the workspace, run the
 * task quietly writing to the log, then optionally push the log via notify.
 */
export function buildCommand(job: Job, holtPath: string): string {
  const holt = shQuote(holtPath);
  const ws = shQuote(job.workspace);
  const log = shQuote(logPath(job.id));
  let cmd = `cd ${ws} && ${holt} run ${shQuote(job.task)}`;
  if (job.brain) cmd += ` --brain ${shQuote(job.brain)}`;
  cmd += ` --quiet --out ${log}`;
  if (job.notify) cmd += ` && ${holt} notify "$(cat ${log})"`;
  return cmd;
}

// ---- launchd (macOS) ----

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** PURE: build a launchd plist that fires this job daily at its time. */
export function buildLaunchdPlist(job: Job, holtPath: string): string {
  const { hour, minute } = parseWhen(job.when);
  const command = buildCommand(job, holtPath);
  const log = logPath(job.id);
  const args = ['/bin/sh', '-lc', command];
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.holt.${xmlEscape(job.id)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

// ---- cron (Linux) ----

const CRON_MARKER = 'holt:';

/** PURE: build a crontab line for this job, tagged for later removal. */
export function buildCronLine(job: Job, holtPath: string): string {
  const { hour, minute } = parseWhen(job.when);
  const command = buildCommand(job, holtPath);
  return `${minute} ${hour} * * * ${command} # ${CRON_MARKER}${job.id}`;
}

/** PURE: remove any crontab lines tagged for this job id. */
export function stripCronLines(crontab: string, id: string): string {
  const marker = `# ${CRON_MARKER}${id}`;
  const kept = crontab
    .split('\n')
    .filter((line) => !line.includes(marker));
  // Collapse a trailing run of blank lines but preserve a single final newline.
  return kept.join('\n').replace(/\n+$/, '\n');
}

/** PURE: append a job's cron line to an existing crontab body. */
export function appendCronLine(crontab: string, line: string): string {
  const base = crontab.replace(/\s*$/, '');
  return (base ? base + '\n' : '') + line + '\n';
}

export function ensureLogsDir(): void {
  mkdirSync(logsDir(), { recursive: true });
}
