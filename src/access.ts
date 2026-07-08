/**
 * Permission-gated access to files OUTSIDE the trusted workspace folder.
 *
 * By default a brain only sees the folder Holt runs in (Claude Code is scoped to
 * cwd). If the user references an absolute path that exists but lives outside the
 * workspace, Holt asks once, per session, before granting the containing DIRECTORY
 * read access to the brain. Grants are in-memory only (a Set on the chat session),
 * never persisted, and reset on the next `holt chat`. Default deny, read-oriented.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { wsHoltDir } from './workspace';

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/** True if `child` is `parent` or nested inside it (both should be resolved abs paths). */
function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

/**
 * Resolve a possibly-`~`/relative token to an absolute, symlink-resolved path, or
 * null if it does not point at an existing filesystem entry.
 */
function resolveExisting(token: string): string | null {
  const expanded = expandHome(token);
  const abs = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  if (!existsSync(abs)) return null;
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The directory to grant for a path: the dir itself, or the file's parent dir. */
export function containingDir(absPath: string): string {
  try {
    return statSync(absPath).isDirectory() ? absPath : dirname(absPath);
  } catch {
    return dirname(absPath);
  }
}

/**
 * Resolve a user-typed path token (from `/allow <path>`) to the absolute
 * containing directory to grant. Expands `~`, makes relative paths absolute
 * against cwd, follows symlinks when the path exists, and returns the dir itself
 * for a directory or the parent dir for a file. Existence is not required.
 */
export function resolveGrantDir(token: string): string {
  const expanded = expandHome(token);
  const abs = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  let real = abs;
  try { real = realpathSync(abs); } catch { /* path may not exist; use abs */ }
  return containingDir(real);
}

/**
 * Scan a user message for absolute-ish paths (`/...` or `~/...`) that EXIST on
 * disk and resolve OUTSIDE the given workspace (and not inside its `.holt`).
 * Returns the deduplicated set of containing directories worth asking about.
 */
export function findOutsidePaths(message: string, workspaceDir: string): string[] {
  const ws = (() => {
    try { return realpathSync(workspaceDir); } catch { return resolve(workspaceDir); }
  })();
  const holt = wsHoltDir(ws);

  // Grab tokens that begin with `/` or `~/` (or a bare `~`). Stop at whitespace.
  // Trailing sentence punctuation is trimmed so "see /etc/hosts." still resolves.
  const tokens = message.match(/(?:~\/|\/|~(?=\s|$))[^\s]*/g) ?? [];
  const dirs = new Set<string>();

  for (const rawToken of tokens) {
    const token = rawToken.replace(/[.,;:!?)"'\]]+$/, '');
    if (!token) continue;
    const abs = resolveExisting(token);
    if (!abs) continue;
    if (isInside(abs, ws)) continue; // inside workspace already
    if (isInside(abs, holt)) continue; // .holt internals, never
    dirs.add(containingDir(abs));
  }

  return [...dirs];
}

/**
 * ============================================================================
 * CLAUDE CODE EXTERNAL-ACCESS FLAGS  --  the ONE place to tune these.
 * ============================================================================
 * Given the set of session-granted directories, build the extra CLI args that
 * let Claude Code READ files in them non-interactively (headless `claude -p`).
 *
 * Why these flags (verified empirically against the installed `claude` CLI):
 *  - `--add-dir=<dir>`   Adds each granted dir to Claude Code's working set so
 *                        tools may touch paths outside cwd. Required: without it
 *                        outside dirs are simply invisible.
 *  - `--allowedTools=Read,Glob,Grep`
 *                        Pre-approves ONLY the read tools so Claude never needs
 *                        an interactive permission prompt (which cannot appear in
 *                        headless `-p` mode and would otherwise cause a refusal).
 *                        Least-privilege: NO Write/Edit/Bash, so this stays
 *                        read-only. We deliberately do NOT use
 *                        `--dangerously-skip-permissions` (grants everything) or
 *                        `--permission-mode acceptEdits` (auto-approves writes).
 *
 * IMPORTANT: use the `--flag=value` form. `--add-dir` and `--allowedTools` are
 * variadic in the Claude CLI; the space-separated form would greedily swallow the
 * trailing prompt positional. The `=` form keeps each flag a single self-contained
 * token so the prompt stays the last argument (see runBrain).
 *
 * To tune after real-world testing, edit ONLY this function.
 */
export function claudeAccessArgs(grantedDirs: Iterable<string>): string[] {
  const dirs = [...grantedDirs];
  if (dirs.length === 0) return [];
  const args = dirs.map((d) => `--add-dir=${d}`);
  args.push('--allowedTools=Read,Glob,Grep');
  return args;
}
