/**
 * `holt` (bare) / `holt launch`: launch the REAL interactive brain, branded as
 * Holt.
 *
 * Where `holt chat` is a thin REPL that shells out to a brain in non-interactive
 * mode per turn (`claude -p`, `codex exec`, `gemini -p`), this command hands the
 * terminal to the brain's own INTERACTIVE session (`claude`, `codex`, `gemini`
 * with no `-p` and no prompt). That session keeps the brain's full agentic power
 * (tool use, permission UI, MCP, in-place edits) while Holt supplies the layer
 * that makes it "Holt": per-folder trust + setup, persistent memory (via the
 * installed Claude Code hooks), and a Holt-forward identity + banner + status
 * line.
 *
 * The flow:
 *   1. ensureSetup(): trust the folder, run onboarding if there is no usable
 *      config/brain, ensure the memory dir exists, install the memory hooks.
 *   2. Resolve the active brain. An API brain has no interactive TUI, so we fall
 *      back to `chat()` with a one-line note.
 *   3. Brand: print the Holt banner, inject a "you are Holt" identity via the
 *      brain's system-prompt flag, set the project status line to "Holt".
 *   4. Launch interactively with runInteractive (stdio inherit). NO reader may be
 *      open at this point: readline and inherited stdio fight over the TTY.
 *   5. On exit: the Stop hook already captured facts during the session, so we do
 *      NOT re-extract. Print a short goodbye and return.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig, BRAIN_IDS, findApiBrain, type BrainId, type HoltConfig } from '../config';
import { isInstalled } from '../brains';
import { runInteractive } from '../install';
import { ensureTrusted, isTrusted, trustDir, workspace } from '../workspace';
import { memDir } from '../memory';
import { hook } from './hook';
import { chat } from './chat';
import { init } from './init';
import { c, createReader } from '../ui';

/**
 * The Holt banner shown before the brain takes over the terminal. Mirrors the
 * banner in cli.ts but trimmed for a launch context (no full usage block).
 */
const LAUNCH_BANNER = `
  ██╗  ██╗ ██████╗ ██╗  ████████╗
  ██║  ██║██╔═══██╗██║  ╚══██╔══╝
  ███████║██║   ██║██║     ██║
  ██╔══██║██║   ██║██║     ██║
  ██║  ██║╚██████╔╝███████╗██║
  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝
  Your assistant, with memory of you. Starting your session...
`;

/**
 * ============================================================================
 * HOLT IDENTITY  --  the ONE place to edit the "you are Holt" system prompt.
 * ============================================================================
 * Injected into the interactive brain so the session presents as Holt rather
 * than the underlying agent. Kept deliberately short: it reframes identity
 * without fighting the brain's own tool/permission behavior.
 */
export const HOLT_IDENTITY =
  'You are Holt, the user\'s personal assistant. You have persistent memory of ' +
  'this user across sessions, provided by the Holt tool you run inside (it ' +
  'recalls relevant notes before each prompt and remembers new facts when the ' +
  'session ends). Act as their assistant. Do not mention the underlying model ' +
  'or that you are looking anything up; just use what you know naturally.';

/**
 * ============================================================================
 * INTERACTIVE INVOCATION  --  the ONE place that maps a brain to its
 * interactive (TUI) form. This is deliberately SEPARATE from cfg.brains[id].args
 * (which hold the NON-interactive flags `-p` / `exec` used by the chat REPL).
 * Passing those here would start a headless run, not an interactive session.
 * ============================================================================
 *   claude  -> `claude`         (interactive is the default; NO -p)
 *   codex   -> `codex`          (interactive; NOT `codex exec`)
 *   gemini  -> `gemini`         (interactive; NOT `-p`)
 */
const INTERACTIVE_ARGS: Record<BrainId, string[]> = {
  claude: [],
  codex: [],
  gemini: [],
};

/**
 * ============================================================================
 * BRANDING FLAGS  --  the ONE place to tune per-brain identity injection.
 * ============================================================================
 * Returns the extra CLI flags that brand the interactive session as Holt.
 *
 * Empirically verified against the installed CLIs (see BRANDING notes in
 * README / CONFIGURATION):
 *  - claude: `--append-system-prompt=<text>` EXISTS and works in interactive
 *    mode (confirmed via `claude --help` and a live probe). We use the
 *    `--flag=value` form so the identity stays a single self-contained token.
 *    Claude Code has NO CLI flag to suppress its own welcome banner, so that
 *    residual chrome is accepted; the status line is branded via project
 *    settings.json instead (see brandStatusLine).
 *  - codex: has NO append-system-prompt flag. Codex reads an `AGENTS.md` project
 *    context file, so identity is delivered there (see brandContextFile); no CLI
 *    branding flag is added.
 *  - gemini: has NO system-prompt flag. Gemini reads a `GEMINI.md` project
 *    context file, so identity is delivered there (see brandContextFile); no CLI
 *    branding flag is added.
 */
function brandingFlags(id: BrainId): string[] {
  if (id === 'claude') return [`--append-system-prompt=${HOLT_IDENTITY}`];
  return [];
}

/**
 * For brains without a system-prompt flag (codex/gemini), write a managed
 * project context file the brain reads on startup. Non-destructive: only writes
 * when the file does not exist, or exists but is already the Holt-managed one.
 * Never throws. Returns the path written, or null.
 */
const CONTEXT_FILE: Partial<Record<BrainId, string>> = {
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
};
const CONTEXT_MARKER = '<!-- holt-managed identity -->';

function brandContextFile(id: BrainId): string | null {
  const name = CONTEXT_FILE[id];
  if (!name) return null;
  const path = join(workspace(), name);
  try {
    if (existsSync(path)) {
      // Only touch a file we created; never clobber the user's own AGENTS.md.
      const cur = readFileSync(path, 'utf8');
      if (!cur.includes(CONTEXT_MARKER)) return null;
    }
    writeFileSync(path, `${CONTEXT_MARKER}\n# Holt\n\n${HOLT_IDENTITY}\n`, 'utf8');
    return path;
  } catch {
    return null;
  }
}

// ---- Claude Code project status line ("Holt") -------------------------------

/**
 * Point the Claude Code status line at "Holt" by merging a minimal `statusLine`
 * into the PROJECT settings file (./.claude/settings.json), NOT the user's
 * global ~/.claude/settings.json. Non-destructive:
 *  - never overwrites an existing statusLine the user already set;
 *  - backs up the file before writing;
 *  - preserves all other settings (including the Holt hooks we just installed).
 * Best-effort: any failure is swallowed. Returns true if it wrote a status line.
 */
function brandStatusLine(): boolean {
  const path = join(workspace(), '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed settings.json is the user's; do not touch it.
    return false;
  }
  if (settings.statusLine) return false; // respect an existing one

  try {
    if (existsSync(path)) copyFileSync(path, `${path}.holt-bak`);
    settings.statusLine = {
      type: 'command',
      command: 'printf "Holt"',
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * A resolved launch target. Either a CLI brain we can run interactively, or the
 * signal that the default is an API brain (no TUI) and we should fall back to
 * chat.
 */
type Target =
  | { kind: 'cli'; id: BrainId; label: string }
  | { kind: 'api'; label: string }
  | null;

function resolveTarget(cfg: HoltConfig): Target {
  const id = cfg.defaultBrain;
  if (!id) return null;
  if ((BRAIN_IDS as string[]).includes(id)) {
    const bid = id as BrainId;
    return { kind: 'cli', id: bid, label: cfg.brains[bid].label };
  }
  const api = findApiBrain(cfg, id);
  if (api) return { kind: 'api', label: `${id} (api: ${api.provider}/${api.model})` };
  // Default points at a CLI brain that is no longer enabled: fall back to any
  // enabled CLI brain so we can still launch interactively.
  const fallback = BRAIN_IDS.find((b) => cfg.brains[b].enabled);
  if (fallback) return { kind: 'cli', id: fallback, label: cfg.brains[fallback].label };
  return null;
}

/**
 * Ensure this folder is set up enough to launch: trusted, has a memory dir, and
 * has the memory hooks installed. Assumes trust/config already exist (the caller
 * runs full onboarding first when they do not). Idempotent, unit-testable, and
 * never opens a reader. Returns nothing; failures in the hook step are tolerated
 * (launch still proceeds, just without ambient memory).
 */
export async function ensureSetup(): Promise<void> {
  const ws = workspace();
  if (!isTrusted(ws)) trustDir(ws);
  mkdirSync(memDir(), { recursive: true });
  // Install the Claude Code memory hooks (inject + capture) so the interactive
  // session is memory-aware. Reuses the exact install path in hook.ts; it is
  // idempotent and prints its own one-liners. Never let a hook failure block the
  // launch.
  try {
    await hook('install', []);
  } catch {
    // ambient memory is best-effort; the session still launches without it
  }
}

/** `holt` (bare) / `holt launch`: launch the interactive brain, branded as Holt. */
export async function launch(): Promise<void> {
  // ---- 1. Ensure setup (auto onboard) --------------------------------------
  let cfg = loadConfig();
  if (!cfg || !cfg.defaultBrain) {
    // No usable config: run full interactive onboarding, then reload. init()
    // manages its own reader and closes it before returning, so no reader is
    // open when we later spawn the brain.
    await init();
    cfg = loadConfig();
    if (!cfg || !cfg.defaultBrain) {
      // User declined setup, or nothing got configured. init() already told them
      // what to do; just leave.
      return;
    }
  } else if (!isTrusted(workspace())) {
    // Config exists but the folder is not trusted (rare: config copied in). Ask
    // once, then continue. Reader is closed before we spawn.
    const { ask, close } = createReader();
    const ok = await ensureTrusted(ask);
    close();
    if (!ok) return;
  }

  // Trust + memory dir + hooks. Safe to call again after init().
  await ensureSetup();

  // ---- 2. Resolve the active brain -----------------------------------------
  const target = resolveTarget(cfg);
  if (!target) {
    console.log(c.dim('\n  No brain is ready. Run "holt setting" or "holt init".\n'));
    return;
  }
  if (target.kind === 'api') {
    // API brains have no interactive TUI. Fall back to the thin REPL, which
    // supports them, with a one-line note.
    console.log(c.dim(`\n  launch needs a CLI brain; starting chat instead (default is ${target.label}).\n`));
    await chat();
    return;
  }

  // Guard: the CLI brain's command must actually be on PATH.
  if (!isInstalled(cfg.brains[target.id].command)) {
    console.log(
      c.red(
        `\n  ${target.label} (${cfg.brains[target.id].command}) is not on your PATH. ` +
          `Run "holt setting" to switch or "holt init" to install it.\n`,
      ),
    );
    return;
  }

  // ---- 3. Brand -------------------------------------------------------------
  console.log(c.accent(LAUNCH_BANNER));

  const flags = [...brandingFlags(target.id)];
  if (flags.length === 0) {
    // No system-prompt flag for this brain: deliver identity via a context file.
    const ctx = brandContextFile(target.id);
    if (ctx) console.log(c.dim(`  Holt identity: ${ctx}`));
  }
  if (target.id === 'claude') brandStatusLine();

  // ---- 4. Launch interactively ---------------------------------------------
  const interactive = INTERACTIVE_ARGS[target.id];
  const args = [...interactive, ...flags];
  console.log(c.dim(`  Starting ${target.label} as Holt. Type "exit" in the session to leave.\n`));
  await runInteractive(cfg.brains[target.id].command, args);

  // ---- 5. On exit -----------------------------------------------------------
  // The Stop hook captured facts during the session (ambient memory), so we do
  // NOT re-extract here. Just say goodbye.
  console.log(c.dim('\nBye. Holt kept what mattered from this session.\n'));
}
