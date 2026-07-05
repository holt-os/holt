/**
 * `holt hook`: ambient per-folder memory for Claude Code. Two directions, both
 * wired as Claude Code hooks so they run with no `holt chat` and no manual tool
 * call:
 *
 *   inject  (UserPromptSubmit) - before each prompt, recall the most relevant
 *           remembered notes for the current folder and print them to stdout;
 *           Claude Code injects whatever this prints as extra context.
 *   capture (Stop)            - when a session ends, distill durable facts from
 *           the transcript and save them to this folder's memory.
 *
 * The runtime bodies (inject/capture) are DEFENSIVE by contract: they never
 * throw, always exit 0, and no-op silently in any folder that is not a trusted
 * Holt workspace with an existing .holt/memory. inject keeps stdout clean (only
 * the context block goes there; every log/error goes to stderr) because stdout
 * is injected verbatim.
 *
 * The management bodies (install/remove/status) edit Claude Code's
 * settings.json, merging into any existing hooks without clobbering unrelated
 * config, and are idempotent.
 *
 * Claude Code hook I/O contract (learned from the AIOS reference hooks
 * inject-context.js and save-session.js):
 *   - The hook receives a JSON object on stdin.
 *   - UserPromptSubmit JSON carries: prompt, cwd, session_id, hook_event_name.
 *     Text printed to stdout on exit 0 is added to the model's context.
 *   - Stop JSON carries: transcript_path, cwd, session_id, stop_hook_active,
 *     hook_event_name. The transcript at transcript_path is JSONL, one record
 *     per line; user/assistant records hold { type, message:{ role, content } }
 *     where content is a string or an array of blocks ({ text } for text,
 *     tool_use/tool_result otherwise).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, BRAIN_IDS, findApiBrain, resolveApiKey, type BrainId, type ApiBrain, type HoltConfig } from '../config';
import { isInstalled, type Turn } from '../brains';
import { isTrusted } from '../workspace';
import { recall, memDir, newSessionId } from '../memory';
import { extractAndSaveFacts } from '../facts';
import { c } from '../ui';

// ---- shape of the two hooks we manage ---------------------------------------

type Direction = 'inject' | 'capture';

interface HookCommand {
  type: 'command';
  command: string;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}
/** Only the two event keys we touch; everything else is preserved verbatim. */
interface SettingsHooks {
  UserPromptSubmit?: HookMatcher[];
  Stop?: HookMatcher[];
  [event: string]: HookMatcher[] | undefined;
}
interface Settings {
  hooks?: SettingsHooks;
  [key: string]: unknown;
}

const EVENT: Record<Direction, 'UserPromptSubmit' | 'Stop'> = {
  inject: 'UserPromptSubmit',
  capture: 'Stop',
};
/** The command Holt writes, and the substring we use to identify our entries. */
const HOOK_CMD: Record<Direction, string> = {
  inject: 'holt hook inject',
  capture: 'holt hook capture',
};

function globalSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}
function projectSettingsPath(): string {
  return join(process.cwd(), '.claude', 'settings.json');
}

// ---- settings file read / write ---------------------------------------------

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Settings) : {};
  } catch {
    // A malformed settings.json is the user's; never overwrite it blindly.
    throw new Error(`could not parse ${path} (not valid JSON) - leaving it untouched`);
  }
}

function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/** Back up the file next to itself before we touch it (only if it exists). */
function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const dest = `${path}.holt-bak`;
  try {
    copyFileSync(path, dest);
    return dest;
  } catch {
    return null;
  }
}

/** True if a matcher block already runs Holt's command for this direction. */
function isHoltEntry(m: HookMatcher, dir: Direction): boolean {
  return Array.isArray(m.hooks) && m.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_CMD[dir]));
}

/** Add Holt's hook for one direction, idempotently. Returns true if it changed. */
function addHook(settings: Settings, dir: Direction): boolean {
  settings.hooks = settings.hooks ?? {};
  const event = EVENT[dir];
  const list = (settings.hooks[event] = settings.hooks[event] ?? []);
  if (list.some((m) => isHoltEntry(m, dir))) return false; // already installed
  list.push({ hooks: [{ type: 'command', command: HOOK_CMD[dir] }] });
  return true;
}

/** Remove ONLY Holt's entries for one direction. Returns true if it changed. */
function removeHook(settings: Settings, dir: Direction): boolean {
  const event = EVENT[dir];
  const list = settings.hooks?.[event];
  if (!Array.isArray(list)) return false;
  let changed = false;
  const kept: HookMatcher[] = [];
  for (const m of list) {
    if (!isHoltEntry(m, dir)) {
      kept.push(m);
      continue;
    }
    // Drop only Holt's command from this matcher; keep any co-located siblings.
    const others = (m.hooks || []).filter((h) => !(typeof h?.command === 'string' && h.command.includes(HOOK_CMD[dir])));
    if (others.length) kept.push({ ...m, hooks: others });
    changed = true;
  }
  if (!changed) return false;
  if (kept.length) settings.hooks![event] = kept;
  else delete settings.hooks![event];
  return true;
}

function isHoltInstalled(settings: Settings, dir: Direction): boolean {
  const list = settings.hooks?.[EVENT[dir]];
  return Array.isArray(list) && list.some((m) => isHoltEntry(m, dir));
}

// ---- install / remove / status ----------------------------------------------

interface Flags {
  inject: boolean;
  capture: boolean;
  project: boolean;
}

function parseFlags(rest: string[]): Flags {
  let injectOnly = false;
  let captureOnly = false;
  let project = false;
  for (const a of rest) {
    if (a === '--inject-only') injectOnly = true;
    else if (a === '--capture-only') captureOnly = true;
    else if (a === '--project') project = true;
  }
  // Default: both. --inject-only / --capture-only narrow it.
  const inject = injectOnly || !captureOnly;
  const capture = captureOnly || !injectOnly;
  return { inject, capture, project };
}

function install(rest: string[]): void {
  const flags = parseFlags(rest);
  const path = flags.project ? projectSettingsPath() : globalSettingsPath();
  const target = flags.project ? 'project (./.claude/settings.json)' : 'global (~/.claude/settings.json)';

  let settings: Settings;
  try {
    settings = readSettings(path);
  } catch (e) {
    console.error(c.red('  ' + (e as Error).message));
    process.exitCode = 1;
    return;
  }

  const bak = backup(path);
  const changed: Direction[] = [];
  if (flags.inject && addHook(settings, 'inject')) changed.push('inject');
  if (flags.capture && addHook(settings, 'capture')) changed.push('capture');

  writeSettings(path, settings);

  const wanted = [flags.inject ? 'inject' : '', flags.capture ? 'capture' : ''].filter(Boolean).join(' + ');
  if (changed.length) {
    console.log(c.green(`  installed ${changed.join(' + ')} into ${target}`));
  } else {
    console.log(c.dim(`  ${wanted} already installed in ${target} (no change)`));
  }
  if (bak) console.log(c.dim(`  backup: ${bak}`));
  console.log(c.dim('  Holt now injects folder memory before each prompt and captures facts when a session ends,'));
  console.log(c.dim('  but only in folders you have trusted with an existing .holt/memory.'));
  console.log(c.dim('  Undo any time with: holt hook remove' + (flags.project ? ' --project' : '')));
}

function remove(rest: string[]): void {
  // --project scopes to the project file; otherwise operate on both files that exist.
  const project = rest.includes('--project');
  const paths = project ? [projectSettingsPath()] : [globalSettingsPath(), projectSettingsPath()];
  let touchedAny = false;

  for (const path of paths) {
    if (!existsSync(path)) continue;
    let settings: Settings;
    try {
      settings = readSettings(path);
    } catch (e) {
      console.error(c.red('  ' + (e as Error).message));
      continue;
    }
    const bak = backup(path);
    let changed = false;
    if (removeHook(settings, 'inject')) changed = true;
    if (removeHook(settings, 'capture')) changed = true;
    if (changed) {
      // Drop an empty hooks object we may have emptied, to leave a clean file.
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
      writeSettings(path, settings);
      console.log(c.green(`  removed Holt hooks from ${path}`));
      if (bak) console.log(c.dim(`  backup: ${bak}`));
      touchedAny = true;
    }
  }

  if (!touchedAny) console.log(c.dim('  no Holt hooks found to remove.'));
}

function status(rest: string[]): void {
  const project = rest.includes('--project');
  const entries: Array<{ label: string; path: string }> = project
    ? [{ label: 'project', path: projectSettingsPath() }]
    : [
        { label: 'global', path: globalSettingsPath() },
        { label: 'project', path: projectSettingsPath() },
      ];

  console.log(c.accent('  Holt ambient hooks'));
  for (const e of entries) {
    if (!existsSync(e.path)) {
      console.log(c.dim(`  ${e.label.padEnd(8)} ${e.path}  (no settings file)`));
      continue;
    }
    let settings: Settings;
    try {
      settings = readSettings(e.path);
    } catch {
      console.log(c.red(`  ${e.label.padEnd(8)} ${e.path}  (unreadable JSON)`));
      continue;
    }
    const inj = isHoltInstalled(settings, 'inject');
    const cap = isHoltInstalled(settings, 'capture');
    const active = [inj ? 'inject' : '', cap ? 'capture' : ''].filter(Boolean).join(' + ') || 'none';
    const mark = inj || cap ? c.green('on ') : c.dim('off');
    console.log(`  ${e.label.padEnd(8)} ${mark}  ${c.dim(e.path)}  ${c.dim('[' + active + ']')}`);
  }
  console.log(c.dim('  Runtime hooks only act in trusted Holt folders that already have .holt/memory.'));
}

// ---- runtime: read the hook JSON off stdin ----------------------------------

/** Read all of stdin with a hard timeout so a hook never hangs Claude Code. */
function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let input = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(input);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        input += chunk;
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
    setTimeout(finish, timeoutMs);
  });
}

interface HookInput {
  prompt?: string;
  cwd?: string;
  transcript_path?: string;
  session_id?: string;
  hook_event_name?: string;
}

function parseHookInput(raw: string): HookInput {
  try {
    const j = JSON.parse(raw || '{}') as unknown;
    return j && typeof j === 'object' ? (j as HookInput) : {};
  } catch {
    return {};
  }
}

/**
 * Move Holt's per-folder view to the hook's cwd. memory.ts / workspace.ts key
 * off process.cwd(), so we chdir there. Return the RESOLVED physical path used
 * for the trust check (macOS /tmp -> /private/tmp), or null if we cannot use it.
 */
function enterFolder(cwd: string | undefined): string | null {
  if (!cwd || !existsSync(cwd)) return null;
  try {
    const real = realpathSync(cwd);
    process.chdir(real);
    return real;
  } catch {
    return null;
  }
}

/** The trusted-folder guard shared by both runtime hooks. */
function guardTrusted(real: string): boolean {
  // Must be a trusted workspace AND already have a memory dir. Never create
  // memory in folders the user never set up, and never inject into unrelated
  // projects. isTrusted() reads the resolved cwd we just chdir'd into.
  if (!isTrusted(real)) return false;
  if (!existsSync(memDir())) return false;
  return true;
}

// ---- runtime: inject (UserPromptSubmit) -------------------------------------

async function inject(): Promise<void> {
  // Everything below is best-effort. On ANY problem we print nothing and exit 0
  // so the user's prompt is never blocked or polluted.
  try {
    const raw = await readStdin(2000);
    const data = parseHookInput(raw);
    const prompt = (data.prompt || '').trim();
    if (prompt.length < 3) return;

    const real = enterFolder(data.cwd);
    if (!real) return;
    if (!guardTrusted(real)) return;

    const session = data.session_id || newSessionId();
    const hits = await recall(prompt, session, 4);
    if (!hits.length) return;

    const lines = hits.map((h) => `- ${h.turn.content.replace(/\s+/g, ' ').trim().slice(0, 500)}`);
    // ONLY the context block goes to stdout; this is injected verbatim.
    process.stdout.write(
      ['[Holt memory - relevant notes from earlier sessions in this folder]', ...lines, ''].join('\n'),
    );
  } catch (e) {
    // Diagnostics to stderr only, never stdout.
    process.stderr.write('holt hook inject: ' + (e instanceof Error ? e.message : String(e)) + '\n');
  }
}

// ---- runtime: capture (Stop) ------------------------------------------------

/** Read a Claude Code JSONL transcript into a plain Turn[] (text only). */
function readTranscript(path: string): Turn[] {
  const out: Turn[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const d = rec as { type?: string; message?: { role?: string; content?: unknown } };
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const m = d.message;
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map((b) => {
          if (typeof b === 'string') return b;
          if (b && typeof (b as { text?: unknown }).text === 'string') return (b as { text: string }).text;
          return ''; // skip tool_use / tool_result blocks
        })
        .join(' ')
        .trim();
    }
    text = text.trim();
    if (text.length < 3) continue;
    out.push({ role: m.role, content: text });
  }
  return out;
}

/** Resolve the folder's configured brain into the shape extractAndSaveFacts wants. */
function resolveExtractionBrain(
  cfg: HoltConfig,
): { kind: 'cli'; id: BrainId } | { kind: 'api'; brain: ApiBrain } | null {
  const id = cfg.defaultBrain;
  if (!id) return null;
  if ((BRAIN_IDS as string[]).includes(id)) {
    const bid = id as BrainId;
    if (!cfg.brains[bid].enabled) return null;
    if (!isInstalled(cfg.brains[bid].command)) return null;
    return { kind: 'cli', id: bid };
  }
  const api = findApiBrain(cfg, id);
  if (api && resolveApiKey(api)) return { kind: 'api', brain: api };
  return null;
}

async function capture(): Promise<void> {
  try {
    const raw = await readStdin(3000);
    const data = parseHookInput(raw);

    const real = enterFolder(data.cwd);
    if (!real) return;
    if (!guardTrusted(real)) return;

    const cfg = loadConfig();
    if (!cfg) return;
    if (cfg.memory?.extractFacts === false) return; // user opted out

    const brain = resolveExtractionBrain(cfg);
    if (!brain) return; // no usable brain -> quietly do nothing

    if (!data.transcript_path) return;
    const history = readTranscript(data.transcript_path);
    if (!history.length) return;

    const session = 'hook-' + (data.session_id || newSessionId());
    const n = await extractAndSaveFacts(brain, cfg, history, session);
    if (n > 0) process.stderr.write(`holt hook capture: saved ${n} fact${n === 1 ? '' : 's'} to ${memDir()}\n`);
  } catch (e) {
    process.stderr.write('holt hook capture: ' + (e instanceof Error ? e.message : String(e)) + '\n');
  }
}

// ---- entry ------------------------------------------------------------------

const USAGE = [
  '  holt hook <command>',
  '',
  '  Wire Holt into Claude Code so folder memory works ambiently: it injects',
  '  relevant remembered notes before each prompt and captures durable facts',
  '  when a session ends. Both run only in trusted Holt folders that already',
  '  have .holt/memory.',
  '',
  '  management:',
  '    install [flags]   write the hooks into Claude Code settings',
  '        --inject-only   install only the before-prompt recall hook',
  '        --capture-only  install only the end-of-session fact hook',
  '        --project       write ./.claude/settings.json (default: ~/.claude)',
  '    remove [--project]  remove ONLY Holt hooks, leaving other settings intact',
  '    status [--project]  show what is installed and which directions are active',
  '',
  '  runtime (invoked by Claude Code, not you):',
  '    inject    UserPromptSubmit body: recall + print a context block',
  '    capture   Stop body: distill facts from the transcript and save them',
  '',
  '  example: holt hook install        # both hooks, global settings',
].join('\n');

export async function hook(sub?: string, rest: string[] = []): Promise<void> {
  switch (sub) {
    case 'install':
      install(rest);
      return;
    case 'remove':
    case 'uninstall':
      remove(rest);
      return;
    case 'status':
      status(rest);
      return;
    case 'inject':
      await inject();
      return;
    case 'capture':
      await capture();
      return;
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      return;
    default:
      console.error(`  Unknown hook command: "${sub}". Run "holt hook help".`);
      process.exitCode = 1;
  }
}
