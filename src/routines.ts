/**
 * Routines: named, reusable, optionally scheduled jobs. A routine bundles the
 * pieces Holt already has -- a task source (an installed skill or an inline
 * prompt), an optional daily schedule, and output routing (stdout / a file /
 * Telegram) -- into one named object. It is the generic version of an AIOS
 * "agent" (a daily brief, a research run, etc.).
 *
 * The store is a single JSON file at ~/.holt/routines.json, one entry per
 * routine, each carrying the absolute workspace it runs in (captured at add
 * time, exactly like scheduler Jobs). A routine that has a schedule ALSO owns a
 * scheduler entry keyed by the routine name; the two stores are kept
 * consistent by the command layer (removing a routine removes its schedule).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR } from './workspace';

/** How a routine sources its prompt. */
export interface RoutineSource {
  kind: 'skill' | 'task';
  value: string; // skill name, or the inline task prompt
}

export interface Routine {
  name: string; // unique key, sanitized [a-z0-9-]
  source: RoutineSource;
  when?: string; // daily "HH:MM"; absent = manual-run only
  notify: boolean; // push the result to Telegram
  out?: string; // file to also write the result to (relative to workspace)
  brain?: string; // brain id override
  workspace: string; // absolute path the routine runs in
}

// ---- name sanitizing (mirrors skills.sanitizeName) ----

export function sanitizeRoutineName(name: string): string {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// ---- paths ----

export function routinesPath(): string {
  return join(GLOBAL_DIR, 'routines.json');
}

// ---- JSON store ----

export function loadRoutines(): Routine[] {
  try {
    const raw = JSON.parse(readFileSync(routinesPath(), 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as Routine[]) : [];
  } catch {
    return [];
  }
}

export function saveRoutines(routines: Routine[]): void {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(routinesPath(), JSON.stringify(routines, null, 2) + '\n', 'utf8');
}

export function findRoutine(name: string): Routine | undefined {
  const want = sanitizeRoutineName(name);
  return loadRoutines().find((r) => r.name === want);
}

/** Insert or replace a routine by name. Returns the new list. */
export function upsertRoutine(routine: Routine): Routine[] {
  const routines = loadRoutines().filter((r) => r.name !== routine.name);
  routines.push(routine);
  saveRoutines(routines);
  return routines;
}

export function removeRoutine(name: string): Routine[] {
  const want = sanitizeRoutineName(name);
  const routines = loadRoutines().filter((r) => r.name !== want);
  saveRoutines(routines);
  return routines;
}

// ---- built-in templates ----

/**
 * Ready-made routines you can create with `--template <t>`. Kept as a small map
 * so it is easy to extend: each entry returns a partial routine (source plus
 * sensible schedule/notify defaults) that `add` fills in with name + workspace.
 */
export interface RoutineTemplate {
  describe: string;
  source: RoutineSource;
  when?: string;
  notify: boolean;
}

export const ROUTINE_TEMPLATES: Record<string, RoutineTemplate> = {
  'daily-brief': {
    describe: 'A short daily brief of what changed and what is open in this folder, pushed to Telegram.',
    source: {
      kind: 'task',
      value:
        'Summarize what changed and what is open in this folder recently, as a short brief. ' +
        'Lead with the most important item. Keep it to a few tight bullets.',
    },
    when: '08:00',
    notify: true,
  },
  standup: {
    describe: 'A daily standup: what got done, what is next, and any blockers in this folder.',
    source: {
      kind: 'task',
      value:
        'Write a short standup for this folder: what got done recently, what is next, ' +
        'and any blockers. Three short sections, plain text.',
    },
    when: '09:00',
    notify: true,
  },
};

/** Names of built-in templates, sorted for stable help output. */
export function templateNames(): string[] {
  return Object.keys(ROUTINE_TEMPLATES).sort();
}
