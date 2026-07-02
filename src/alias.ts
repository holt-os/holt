/**
 * Custom launch command (e.g. `ai` -> holt chat).
 *
 * Preferred mechanism: write a tiny executable launcher into the same bin
 * directory that `holt` itself runs from. That directory is on PATH already,
 * so the command works immediately in the current shell, with no sourcing and
 * no new terminal. Falls back to a shell rc alias when the bin dir is not
 * writable, and records what it did in ~/.holt/launcher.json so settings can
 * show and remove it reliably.
 */
import { homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  chmodSync,
  realpathSync,
} from 'node:fs';

const START = '# >>> holt launch alias >>>';
const END = '# <<< holt launch alias <<<';
const SHIM_MARKER = '# holt launcher';

const GLOBAL_DIR = join(homedir(), '.holt');
const LAUNCHER_STATE = join(GLOBAL_DIR, 'launcher.json');

export interface LauncherState {
  name: string;
  kind: 'bin' | 'rc';
  file: string;
}

export interface AliasResult {
  ok: boolean;
  kind: 'bin' | 'rc' | 'none';
  file: string;
  /** True when the command works immediately, no sourcing needed. */
  immediate: boolean;
  message?: string;
}

export function rcFile(): string {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return join(homedir(), '.zshrc');
  if (shell.includes('bash')) return join(homedir(), '.bashrc');
  return join(homedir(), '.profile');
}

function readState(): LauncherState | null {
  try {
    return JSON.parse(readFileSync(LAUNCHER_STATE, 'utf8')) as LauncherState;
  } catch {
    return null;
  }
}

function writeState(state: LauncherState | null): void {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  if (state) writeFileSync(LAUNCHER_STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  else if (existsSync(LAUNCHER_STATE)) rmSync(LAUNCHER_STATE);
}

/** Directories on PATH, for checking a candidate bin dir is actually reachable. */
function pathDirs(): string[] {
  return (process.env.PATH || '').split(delimiter).filter(Boolean);
}

/**
 * The directory holt was launched from (the npm global bin dir when installed
 * globally). Only trusted when it is on PATH, so the launcher is reachable.
 */
function launcherBinDir(): string | null {
  const dirs = pathDirs();
  const candidates: string[] = [];
  const invoked = process.argv[1];
  if (invoked) candidates.push(dirname(invoked));
  candidates.push(dirname(process.execPath)); // node's own bin dir (same dir under homebrew/nvm)
  for (const dir of candidates) {
    if (!dirs.includes(dir)) continue;
    try {
      // realpath guards against a PATH entry that is itself a symlink.
      if (dirs.includes(dir) || dirs.includes(realpathSync(dir))) return dir;
    } catch {
      /* try next */
    }
  }
  return null;
}

function installRcAlias(name: string): AliasResult {
  const file = rcFile();
  const block = `${START}\nalias ${name}="holt chat"\n${END}`;
  try {
    let content = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const re = new RegExp(`${START}[\\s\\S]*?${END}`);
    if (re.test(content)) content = content.replace(re, block);
    else content = content.replace(/\n*$/, '\n') + block + '\n';
    writeFileSync(file, content, 'utf8');
    writeState({ name, kind: 'rc', file });
    return { ok: true, kind: 'rc', file, immediate: false };
  } catch (e) {
    return { ok: false, kind: 'none', file, immediate: false, message: `Could not write ${file}: ${(e as Error).message}` };
  }
}

/**
 * Install the launch command. Tries the executable-launcher route first (works
 * immediately), falls back to a shell rc alias (needs source or a new shell).
 */
export function installAlias(name: string): AliasResult {
  removeAlias(); // never leave two mechanisms behind

  if (process.platform !== 'win32') {
    const binDir = launcherBinDir();
    if (binDir) {
      const file = join(binDir, name);
      // Never overwrite something that is not ours.
      if (existsSync(file)) {
        try {
          if (!readFileSync(file, 'utf8').includes(SHIM_MARKER)) {
            return { ok: false, kind: 'none', file, immediate: false, message: `"${name}" already exists at ${file}. Pick another word.` };
          }
        } catch {
          return { ok: false, kind: 'none', file, immediate: false, message: `"${name}" already exists at ${file}. Pick another word.` };
        }
      }
      try {
        writeFileSync(file, `#!/bin/sh\n${SHIM_MARKER}\nexec holt chat "$@"\n`, 'utf8');
        chmodSync(file, 0o755);
        writeState({ name, kind: 'bin', file });
        return { ok: true, kind: 'bin', file, immediate: true };
      } catch {
        // Bin dir not writable (system installs): fall through to the rc alias.
      }
    }
  }
  return installRcAlias(name);
}

/** Remove whichever launcher mechanism is installed. */
export function removeAlias(): AliasResult {
  const state = readState();

  // Remove a recorded bin launcher, but only if it is really ours.
  if (state?.kind === 'bin' && existsSync(state.file)) {
    try {
      if (readFileSync(state.file, 'utf8').includes(SHIM_MARKER)) rmSync(state.file);
    } catch {
      /* leave it */
    }
  }

  // Always also clear any rc alias block (covers upgrades from older versions).
  const file = rcFile();
  try {
    if (existsSync(file)) {
      const content = readFileSync(file, 'utf8').replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n*`), '\n');
      writeFileSync(file, content, 'utf8');
    }
    writeState(null);
    return { ok: true, kind: 'none', file, immediate: true };
  } catch (e) {
    writeState(null);
    return { ok: false, kind: 'none', file, immediate: true, message: (e as Error).message };
  }
}

/** The current launch command name, if one is installed. */
export function currentAlias(): string | null {
  const state = readState();
  if (state) {
    if (state.kind === 'bin') {
      try {
        if (existsSync(state.file) && readFileSync(state.file, 'utf8').includes(SHIM_MARKER)) return state.name;
      } catch {
        return null;
      }
      return null;
    }
    return state.name;
  }
  // Older versions only wrote the rc block; detect it for continuity.
  try {
    const m = readFileSync(rcFile(), 'utf8').match(/alias\s+([^\s=]+)="holt chat"/);
    return m ? (m[1] as string) : null;
  } catch {
    return null;
  }
}
