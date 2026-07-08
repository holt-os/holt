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
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, realpathSync, appendFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, BRAIN_IDS, findApiBrain, resolveApiKey, type BrainId, type ApiBrain, type HoltConfig } from '../config';
import { isInstalled, type Turn } from '../brains';
import { isTrusted, GLOBAL_DIR } from '../workspace';
import { recall, memDir, newSessionId } from '../memory';
import { extractAndSaveFacts, MIN_EXCHANGES_FOR_EXTRACTION } from '../facts';
import { syncWiki, resolveBrainMaintainer, wikiDir } from '../wiki';
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

// ---- runtime: observability -------------------------------------------------

/**
 * Append one line to ~/.holt/hooks.log. This is the safety net for the ambient
 * hooks: because both bodies are silent-by-contract (they exit 0 and print
 * nothing on a no-op), a maintainer has no way to see WHY capture did nothing on
 * a real Claude Code run. Every capture() invocation logs exactly one outcome
 * line (plus one raw-fields line at the top); inject() logs only when
 * HOLT_HOOK_DEBUG is set, since it fires on every prompt. Creates ~/.holt if
 * needed and NEVER throws: logging must not perturb the hook it observes.
 */
function hookLog(msg: string): void {
  try {
    mkdirSync(GLOBAL_DIR, { recursive: true });
    appendFileSync(join(GLOBAL_DIR, 'hooks.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {
    // logging is best-effort; swallow everything
  }
}

/** File size in bytes, or 0 if the path is missing/unreadable. Never throws. */
function fileBytes(path: string | undefined): number {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ---- runtime: capture throttle state ----------------------------------------

/**
 * Claude Code fires the Stop event after EVERY assistant response, so once a
 * session passes the 3-exchange minimum, capture() would re-run full fact
 * extraction (a brain call) on every subsequent Stop. saveFact dedups, so it
 * stays correct, but the repeated brain calls are wasteful and add latency at
 * each turn's end. We throttle by remembering, per session, the exchange count
 * at the last successful extraction, and only re-distilling once the session
 * has gained at least THROTTLE_MIN_NEW_EXCHANGES new exchanges.
 */

/** Minimum new exchanges since the last capture before we re-distill a session. */
const THROTTLE_MIN_NEW_EXCHANGES = 2;

/** Per-session state file: ~/.holt/hook-state.json. */
function hookStatePath(): string {
  return join(GLOBAL_DIR, 'hook-state.json');
}

/** Shape of one session's throttle record. */
interface HookSessionState {
  lastExchanges: number;
}
type HookState = Record<string, HookSessionState>;

/** Read the throttle store. A missing/corrupt file reads as empty. Never throws. */
function readHookState(): HookState {
  try {
    const parsed = JSON.parse(readFileSync(hookStatePath(), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as HookState;
  } catch {
    return {};
  }
}

/** Look up the last processed exchange count for a session (0 if unknown). */
function lastProcessedExchanges(state: HookState, sessionId: string): number {
  const rec = state[sessionId];
  return rec && typeof rec.lastExchanges === 'number' ? rec.lastExchanges : 0;
}

/** Record a successful extraction for a session. Best-effort; never throws. */
function saveHookState(sessionId: string, exchanges: number): void {
  try {
    mkdirSync(GLOBAL_DIR, { recursive: true });
    const state = readHookState();
    state[sessionId] = { lastExchanges: exchanges };
    writeFileSync(hookStatePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    // throttle state is best-effort; never perturb the hook it serves
  }
}

// ---- runtime: inject (UserPromptSubmit) -------------------------------------

async function inject(): Promise<void> {
  // Everything below is best-effort. On ANY problem we print nothing and exit 0
  // so the user's prompt is never blocked or polluted. inject logs to
  // ~/.holt/hooks.log ONLY when HOLT_HOOK_DEBUG is set (it fires per prompt).
  const debug = !!process.env.HOLT_HOOK_DEBUG;
  const dlog = (m: string): void => {
    if (debug) hookLog(m);
  };
  try {
    const raw = await readStdin(2000);
    const data = parseHookInput(raw);
    dlog(
      `inject cwd=${data.cwd ?? '(none)'} event=${data.hook_event_name ?? 'UserPromptSubmit'} hasCwd=${!!data.cwd} promptLen=${(data.prompt || '').trim().length}`,
    );
    const prompt = (data.prompt || '').trim();
    if (prompt.length < 3) {
      dlog('inject -> prompt too short');
      return;
    }

    const real = enterFolder(data.cwd);
    if (!real) {
      dlog('inject -> no cwd');
      return;
    }
    if (!guardTrusted(real)) {
      dlog(`inject -> untrusted or no .holt/memory (real=${real})`);
      return;
    }

    const session = data.session_id || newSessionId();
    const hits = await recall(prompt, session, 4);
    if (!hits.length) {
      dlog('inject -> recalled 0 notes');
      return;
    }

    const lines = hits.map((h) => `- ${h.turn.content.replace(/\s+/g, ' ').trim().slice(0, 500)}`);
    // ONLY the context block goes to stdout; this is injected verbatim. The
    // wording frames these as already-known background so the model uses them
    // silently instead of narrating "let me check your memory / recalled N".
    process.stdout.write(
      [
        'Background on this user, recalled from earlier sessions (use it directly, do not mention looking it up):',
        ...lines,
        '',
      ].join('\n'),
    );
    dlog(`inject -> injected ${hits.length} note(s)`);
  } catch (e) {
    // Diagnostics to stderr only, never stdout.
    process.stderr.write('holt hook inject: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    dlog('inject -> error: ' + (e instanceof Error ? e.message : String(e)));
  }
}

// ---- runtime: capture (Stop) ------------------------------------------------

/** Line count of a transcript file (for the "parsed 0 turns" diagnostic). */
function countLines(raw: string): number {
  let n = 0;
  for (const line of raw.split('\n')) if (line.trim()) n++;
  return n;
}

/**
 * Pull display text out of a `content` value that is either a string or an array
 * of blocks. From a block array we take {type:'text'}.text, plus any block that
 * carries a string `text`, and we SKIP tool_use / tool_result / thinking blocks.
 * Returns '' when nothing textual is present. Never throws.
 */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b === 'string') {
      parts.push(b);
      continue;
    }
    if (!b || typeof b !== 'object') continue;
    const blk = b as { type?: unknown; text?: unknown };
    // Skip non-text block kinds explicitly.
    if (blk.type === 'tool_use' || blk.type === 'tool_result' || blk.type === 'thinking') continue;
    if (typeof blk.text === 'string') parts.push(blk.text);
  }
  return parts.join(' ').trim();
}

/**
 * Read a Claude Code JSONL transcript into a plain Turn[] (text only). Tolerant
 * of Claude Code v2.x shapes: a record counts as a turn if EITHER its top-level
 * `type` is 'user'/'assistant' OR its nested `message.role` is 'user'/'assistant'.
 * The role is taken from message.role when present, else from top-level type.
 * Text comes from message.content, falling back to a top-level `content`.
 * Non-message records (mode, permission-mode, summary, system,
 * file-history-snapshot, etc.) and empty-text turns are skipped. Never throws.
 */
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
    if (!rec || typeof rec !== 'object') continue;
    const d = rec as { type?: unknown; content?: unknown; message?: { role?: unknown; content?: unknown } };
    const topType = d.type === 'user' || d.type === 'assistant' ? d.type : undefined;
    const m = d.message && typeof d.message === 'object' ? d.message : undefined;
    const msgRole = m && (m.role === 'user' || m.role === 'assistant') ? (m.role as 'user' | 'assistant') : undefined;

    // A turn if EITHER signal says user/assistant. This is the loosening: the
    // old code required BOTH, which drops records that carry only one of them.
    const role = msgRole ?? topType;
    if (role !== 'user' && role !== 'assistant') continue;

    // Prefer message.content; fall back to a top-level content.
    let text = m ? textFromContent(m.content) : '';
    if (!text) text = textFromContent(d.content);

    text = text.trim();
    if (text.length < 3) continue;
    out.push({ role, content: text });
  }
  return out;
}

/**
 * Resolve an ABSOLUTE path to a CLI command when a bare `which` fails. The Stop
 * hook subprocess can run under a reduced PATH (Claude Code spawns hooks with a
 * minimal environment), so `isInstalled('claude')` may return false even though
 * the brain works fine in the user's shell. We try, in order:
 *   (a) the user's login shell: `$SHELL -lc "command -v <cmd>"` (loads profile);
 *   (b) a list of common install dirs.
 * Returns the resolved absolute path, or null if nothing was found. Never throws.
 */
function resolveCommandPath(command: string): string | null {
  // Already an absolute path that exists? Use it as-is.
  if (command.startsWith('/') && existsSync(command)) return command;

  // (a) Ask the login shell, which sources the user's profile / PATH.
  try {
    const shell = process.env.SHELL || '/bin/sh';
    const res = spawnSync(shell, ['-lc', 'command -v ' + command], { encoding: 'utf8' });
    if (res.status === 0) {
      const p = (res.stdout || '').trim().split('\n')[0]?.trim();
      if (p && p.startsWith('/') && existsSync(p)) return p;
    }
  } catch {
    // fall through to the directory probe
  }

  // (b) Probe common install locations directly.
  const home = homedir();
  const dirs = [
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global', 'bin'),
    '/usr/bin',
    '/bin',
  ];
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** What resolveExtractionBrain hands back, with diagnostics for the log line. */
type BrainResolution =
  | { kind: 'cli'; id: BrainId; commandOverride?: string }
  | { kind: 'api'; brain: ApiBrain };

interface BrainResolveResult {
  brain: BrainResolution | null;
  /** For the hooks.log "no usable brain" line. */
  diag: { defaultBrain: string; command: string; whichFound: boolean; resolvedPath: string | null };
}

/**
 * Resolve the folder's configured brain into the shape extractAndSaveFacts wants,
 * carrying diagnostics for the hook log. For a CLI brain, if a bare `which` fails
 * we try to resolve an absolute path (login shell + common dirs) and pass it as a
 * commandOverride rather than skipping.
 */
function resolveExtractionBrain(cfg: HoltConfig): BrainResolveResult {
  const id = cfg.defaultBrain;
  const diag = { defaultBrain: id ?? '(none)', command: '(none)', whichFound: false, resolvedPath: null as string | null };
  if (!id) return { brain: null, diag };

  if ((BRAIN_IDS as string[]).includes(id)) {
    const bid = id as BrainId;
    const command = cfg.brains[bid].command;
    diag.command = command;
    if (!cfg.brains[bid].enabled) return { brain: null, diag };

    const whichFound = isInstalled(command);
    diag.whichFound = whichFound;
    if (whichFound) {
      // On PATH already; no override needed.
      return { brain: { kind: 'cli', id: bid }, diag };
    }
    // Bare `which` failed under the hook's reduced PATH. Try an absolute path.
    const resolved = resolveCommandPath(command);
    diag.resolvedPath = resolved;
    if (resolved) {
      return { brain: { kind: 'cli', id: bid, commandOverride: resolved }, diag };
    }
    return { brain: null, diag };
  }

  const api = findApiBrain(cfg, id);
  if (api && resolveApiKey(api)) return { brain: { kind: 'api', brain: api }, diag };
  return { brain: null, diag };
}

async function capture(): Promise<void> {
  // capture is silent-by-contract, so it ALWAYS writes exactly one outcome line
  // to ~/.holt/hooks.log (plus a raw-fields line up top). That log is the only
  // way to diagnose why a real Claude Code Stop hook saved nothing.
  const cwdForLog = process.cwd();
  try {
    const raw = await readStdin(3000);
    const data = parseHookInput(raw);
    hookLog(
      `capture-fields event=${data.hook_event_name ?? 'Stop'} hasCwd=${!!data.cwd} hasTranscriptPath=${!!data.transcript_path} transcriptBytes=${fileBytes(data.transcript_path)} stdinBytes=${raw.length}`,
    );

    const real = enterFolder(data.cwd);
    if (!real) {
      hookLog(`capture cwd=${data.cwd ?? cwdForLog} event=Stop -> no cwd`);
      return;
    }
    if (!guardTrusted(real)) {
      hookLog(`capture cwd=${real} event=Stop -> untrusted or no .holt/memory (real=${real})`);
      return;
    }

    const cfg = loadConfig();
    if (!cfg) {
      hookLog(`capture cwd=${real} event=Stop -> no config`);
      return;
    }
    if (cfg.memory?.extractFacts === false) {
      hookLog(`capture cwd=${real} event=Stop -> extractFacts off`);
      return; // user opted out
    }

    const { brain, diag } = resolveExtractionBrain(cfg);
    if (!brain) {
      hookLog(
        `capture cwd=${real} event=Stop -> no usable brain (defaultBrain=${diag.defaultBrain} command=${diag.command} whichFound=${diag.whichFound} resolvedPath=${diag.resolvedPath ?? 'none'})`,
      );
      return; // no usable brain -> quietly do nothing
    }
    if (brain.kind === 'cli' && brain.commandOverride) {
      hookLog(`capture cwd=${real} event=Stop -> brain resolved via absolute path (resolvedPath=${brain.commandOverride})`);
    }

    if (!data.transcript_path) {
      hookLog(`capture cwd=${real} event=Stop -> no transcript_path`);
      return;
    }
    const history = readTranscript(data.transcript_path);
    if (!history.length) {
      let bytes = 0;
      let lines = 0;
      try {
        const rawT = readFileSync(data.transcript_path, 'utf8');
        bytes = Buffer.byteLength(rawT, 'utf8');
        lines = countLines(rawT);
      } catch {
        // path unreadable; leave zeros
      }
      hookLog(`capture cwd=${real} event=Stop -> transcript parsed 0 turns (path=${data.transcript_path} bytes=${bytes} lines=${lines})`);
      return;
    }
    const exchanges = Math.floor(history.length / 2);
    if (exchanges < MIN_EXCHANGES_FOR_EXTRACTION) {
      hookLog(`capture cwd=${real} event=Stop -> only ${exchanges} exchange(s) (<${MIN_EXCHANGES_FOR_EXTRACTION}, skipped)`);
      return;
    }

    // Throttle: Claude Code fires Stop after every response, so past the minimum
    // we would re-distill on every turn. Only re-run extraction once the session
    // has gained at least THROTTLE_MIN_NEW_EXCHANGES exchanges since we last
    // captured it. With no session_id we cannot track state, so we process (as
    // before) but do not persist. lastProcessed is 0 for a never-seen session.
    const throttleId = data.session_id || null;
    const lastProcessed = throttleId ? lastProcessedExchanges(readHookState(), throttleId) : 0;
    if (throttleId && exchanges - lastProcessed < THROTTLE_MIN_NEW_EXCHANGES) {
      hookLog(
        `capture cwd=${real} event=Stop -> throttled (exchanges=${exchanges} lastProcessed=${lastProcessed}, need +${THROTTLE_MIN_NEW_EXCHANGES})`,
      );
      return;
    }

    const session = 'hook-' + (data.session_id || newSessionId());
    const n = await extractAndSaveFacts(brain, cfg, history, session);
    if (throttleId) saveHookState(throttleId, exchanges);
    hookLog(`capture cwd=${real} event=Stop -> saved ${n} fact${n === 1 ? '' : 's'}`);
    if (n > 0) process.stderr.write(`holt hook capture: saved ${n} fact${n === 1 ? '' : 's'} to ${memDir()}\n`);

    // Ambient wiki auto-sync: when the folder opted in (wiki.autoSync), fold the
    // freshly captured facts into wiki pages too. Best-effort and STDOUT-CLEAN by
    // contract: syncWiki never throws, and any note goes to stderr only. Still
    // exit 0 regardless of outcome.
    if (cfg.wiki?.autoSync) {
      const res = await syncWiki(cfg, () => resolveBrainMaintainer(cfg));
      if (res.status === 'ok' && res.changed) {
        process.stderr.write(
          `holt hook capture: updated the wiki (${res.created} created, ${res.updated} updated) in ${wikiDir()}\n`,
        );
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write('holt hook capture: ' + msg + '\n');
    hookLog(`capture cwd=${cwdForLog} event=Stop -> error: ${msg}`);
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
