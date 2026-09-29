/**
 * `holt statusline`: the Claude Code status-line renderer, branded as Holt.
 *
 * This is an INTERNAL/plumbing command. It is not something a user types: it is
 * wired into a project's `./.claude/settings.json` by `brandStatusLine`
 * (src/commands/launch.ts) as the `statusLine` command. Claude Code invokes it
 * once per render and pipes a JSON status object to its STDIN; whatever this
 * prints to STDOUT becomes the status line text.
 *
 * Contract (DEFENSIVE by design, like the ambient hooks in hook.ts):
 *   - Read STDIN with a short timeout so it NEVER hangs a Claude Code render,
 *     even if nothing is piped (empty stdin resolves fast).
 *   - Tolerate ANY shape: valid JSON, malformed JSON, empty input, or fields in
 *     unexpected places / types. Never throw.
 *   - Always print exactly ONE compact line. The baseline is `Holt`. When we can
 *     recover a folder and/or model from the payload we append them with a
 *     middle-dot separator (NOT an em-dash):
 *     `Holt · <folder> (<branch>) · <model> · [██░░░…] 8%`: the git branch
 *     and the context-window fill bar, ANSI-coloured unless NO_COLOR is set.
 *
 * The status line is the PERSISTENT Holt marker inside the interactive session:
 * Claude Code renders its own (uncustomizable) welcome box above, but this line
 * stays put and keeps the session visibly "Holt".
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/** Middle dot (U+00B7) separator. Deliberately NOT an em-dash. */
const SEP = ' · ';

/**
 * Read all of STDIN with a hard timeout so the status-line command never hangs a
 * render. Mirrors the readStdin pattern in src/commands/hook.ts. Resolves with
 * whatever was buffered when stdin ends, errors, or the timeout fires. When no
 * stdin is piped (e.g. `</dev/null`), 'end' fires immediately so we return ''.
 */
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

/** A plain object index accessor that never throws and tolerates non-objects. */
function get(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

/** Coerce a value to a trimmed non-empty string, or undefined. Never throws. */
function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** Raw working dir from the payload (field shapes seen across Claude Code versions). */
function dirFrom(data: unknown): string | undefined {
  const ws = get(data, 'workspace');
  return (
    str(get(ws, 'current_dir')) ??
    str(get(ws, 'project_dir')) ??
    str(get(ws, 'cwd')) ??
    str(get(data, 'cwd')) ??
    str(get(data, 'current_dir'))
  );
}

/**
 * Pull the working folder out of a Claude Code status payload, tolerating the
 * field shapes seen across versions:
 *   - workspace.current_dir  (common)
 *   - workspace.project_dir  (seen)
 *   - cwd                    (top-level fallback)
 *   - current_dir            (top-level fallback)
 * Returns the folder BASENAME (what a human recognizes), or undefined.
 */
function folderFrom(data: unknown): string | undefined {
  const dir = dirFrom(data);
  if (!dir) return undefined;
  try {
    const base = basename(dir.replace(/[\\/]+$/, ''));
    return base.length ? base : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull a human model label out of the payload, tolerating:
 *   - model.display_name  (preferred label)
 *   - model.id            (fallback id)
 *   - model               (when model is itself a string)
 *   - model_display_name / model_id (flat fallbacks)
 * Returns the label, or undefined.
 */
function modelFrom(data: unknown): string | undefined {
  const model = get(data, 'model');
  if (typeof model === 'string') return str(model);
  return (
    str(get(model, 'display_name')) ??
    str(get(model, 'id')) ??
    str(get(data, 'model_display_name')) ??
    str(get(data, 'model_id'))
  );
}

/**
 * Context-window fill as an integer 0..100, or undefined. Prefers
 * context_window.used_percentage; falls back to deriving it from
 * current_usage input tokens / context_window_size when only those exist.
 */
function contextPctFrom(data: unknown): number | undefined {
  const cw = get(data, 'context_window');
  const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
  const used = get(cw, 'used_percentage');
  if (typeof used === 'number' && Number.isFinite(used)) return clamp(used);
  if (typeof used === 'string' && used.trim() && Number.isFinite(Number(used))) {
    return clamp(Number(used));
  }
  const size = get(cw, 'context_window_size');
  const cu = get(cw, 'current_usage');
  if (typeof size === 'number' && size > 0 && cu && typeof cu === 'object') {
    const n = (k: string): number => {
      const v = get(cu, k);
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    const tokens =
      n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
    if (tokens > 0) return clamp((tokens / size) * 100);
  }
  return undefined;
}

/** 20-cell bar, one cell per 5%. */
export function contextBar(pct: number | undefined): string {
  if (pct === undefined) return `[${'░'.repeat(20)}] --`;
  const filled = Math.floor(pct / 5);
  return `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${pct}%`;
}

/** ANSI styling, disabled when NO_COLOR is set. */
function paint(code: string, text: string, color: boolean): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/**
 * PURE: build the status line from an already-parsed (or unparsed) payload.
 * Shape: `Holt · <folder> (<branch>) · <model> · [██░░…] 8%`. Every segment
 * after `Holt` is dropped when the payload can't supply it; the context bar is
 * shown whenever a folder or model was recovered (i.e. it's a real payload).
 */
export function renderStatusLine(
  data: unknown,
  opts: { branch?: string; color?: boolean } = {},
): string {
  const color = opts.color ?? false;
  const parts = [paint('1;35', 'Holt', color)];
  const folder = folderFrom(data);
  if (folder) {
    const branch = str(opts.branch);
    parts.push(
      paint('1;34', folder, color) + (branch ? ' ' + paint('1;33', `(${branch})`, color) : ''),
    );
  }
  const model = modelFrom(data);
  if (model) parts.push(paint('0;36', model, color));
  if (folder || model) parts.push(paint('0;32', contextBar(contextPctFrom(data)), color));
  return parts.join(SEP);
}

/** Current git branch for a dir, or undefined. Fast, lock-free, never throws. */
function gitBranch(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    const out = execFileSync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return str(out);
  } catch {
    return undefined;
  }
}

/** Parse the raw stdin into a value, tolerating empty/malformed input. */
function parse(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/**
 * The command body. Reads the status JSON off stdin, prints exactly one line.
 * Never throws: any failure degrades to the bare `Holt` marker.
 */
export async function statusline(): Promise<void> {
  let line = 'Holt';
  try {
    const raw = await readStdin(1000);
    const data = parse(raw);
    line = renderStatusLine(data, {
      branch: gitBranch(dirFrom(data)),
      color: !process.env.NO_COLOR,
    });
  } catch {
    line = 'Holt';
  }
  // Single compact line; Claude Code uses stdout as the status text.
  process.stdout.write(line + '\n');
}
