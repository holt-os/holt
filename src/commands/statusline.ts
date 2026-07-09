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
 *     middle-dot separator: `Holt · <folder> · <model>` (NOT an em-dash).
 *
 * The status line is the PERSISTENT Holt marker inside the interactive session:
 * Claude Code renders its own (uncustomizable) welcome box above, but this line
 * stays put and keeps the session visibly "Holt".
 */
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
  const ws = get(data, 'workspace');
  const dir =
    str(get(ws, 'current_dir')) ??
    str(get(ws, 'project_dir')) ??
    str(get(ws, 'cwd')) ??
    str(get(data, 'cwd')) ??
    str(get(data, 'current_dir'));
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

/** PURE: build the status line from an already-parsed (or unparsed) payload. */
export function renderStatusLine(data: unknown): string {
  const parts = ['Holt'];
  const folder = folderFrom(data);
  if (folder) parts.push(folder);
  const model = modelFrom(data);
  if (model) parts.push(model);
  return parts.join(SEP);
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
    line = renderStatusLine(parse(raw));
  } catch {
    line = 'Holt';
  }
  // Single compact line; Claude Code uses stdout as the status text.
  process.stdout.write(line + '\n');
}
