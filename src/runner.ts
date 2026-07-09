/**
 * Shared task runner: the non-interactive engine behind `holt run`, scheduled
 * jobs, and the Telegram bot. It resolves the brain, recalls relevant memory,
 * builds a prompt, runs the brain once, and (optionally) stores the exchange
 * back to memory. The selected brain executes the task; the local model is only
 * used for memory. Other branches compile against these signatures.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig, BRAIN_IDS, findApiBrain, resolveApiKey, type BrainId, type ApiBrain, type HoltConfig } from './config';
import { isInstalled, renderPrompt, runBrain, looksLikeAuthError } from './brains';
import { runApiBrain } from './apibrain';
import { recall, appendTurn, embed, newSessionId } from './memory';
import { skillsPromptBlock } from './skills';

export interface RunOptions {
  brainId?: string; // override the default brain (CLI or API brain id)
  recall?: boolean; // include memory recall in the prompt (default true)
  store?: boolean; // append the task and result to memory (default true)
  onChunk?: (chunk: string) => void; // stream output as it arrives
}

export interface RunResult {
  ok: boolean;
  text: string;
  brainLabel: string;
}

/** A resolved brain to dispatch to: either a CLI brain or an API brain. */
type Active =
  | { kind: 'cli'; id: BrainId; label: string }
  | { kind: 'api'; id: string; label: string; brain: ApiBrain };

/** Resolve a brain id to a CLI or API brain, exactly like chat.ts resolveActive. */
function resolveActive(cfg: HoltConfig, id: string): Active | null {
  if ((BRAIN_IDS as string[]).includes(id)) {
    const b = cfg.brains[id as BrainId];
    return { kind: 'cli', id: id as BrainId, label: b.label };
  }
  const api = findApiBrain(cfg, id);
  if (api) return { kind: 'api', id, label: `${id} (api: ${api.provider}/${api.model})`, brain: api };
  return null;
}

/**
 * Run a single task non-interactively. Resolves the brain, recalls memory,
 * builds a prompt (recall + skills + task), runs the brain once, streams the
 * output through opts.onChunk, and stores the exchange to memory. Never throws.
 */
export async function runTask(task: string, opts: RunOptions = {}): Promise<RunResult> {
  try {
    const cfg = loadConfig();
    if (!cfg || !cfg.defaultBrain) {
      return { ok: false, text: 'No Holt setup in this folder. Run holt init.', brainLabel: '' };
    }

    const wantId = opts.brainId ?? cfg.defaultBrain;
    const active = resolveActive(cfg, wantId);
    if (!active) {
      return { ok: false, text: `Brain "${wantId}" is not configured. Run holt setting.`, brainLabel: '' };
    }

    // Availability guards: CLI must be on PATH, API brain must resolve a key.
    if (active.kind === 'cli' && !isInstalled(cfg.brains[active.id].command)) {
      return {
        ok: false,
        text: `${active.label} (${cfg.brains[active.id].command}) is not on your PATH. Install it or run holt setting.`,
        brainLabel: active.label,
      };
    }
    if (active.kind === 'api' && !resolveApiKey(active.brain)) {
      return {
        ok: false,
        text: `${active.label} has no API key. Run holt setting to add one.`,
        brainLabel: active.label,
      };
    }

    // Per-run session id so recall sees all prior memory, and the stored turns
    // land in a fresh session that recall will surface next time.
    const runSession = 'run-' + newSessionId();

    const recalled = opts.recall !== false ? await recall(task, runSession, 4) : [];

    const block = skillsPromptBlock();
    const base = renderPrompt([], task, recalled);
    const prompt = block ? block + '\n\n' + base : base;

    const res = active.kind === 'cli'
      ? await runBrain(cfg.brains[active.id], prompt, opts.onChunk)
      : await runApiBrain(active.brain, prompt, opts.onChunk);

    // A signed-out brain often replies (even with exit code 0) in its own prose,
    // e.g. "Invalid API key. Please run /login". Catch that before storing so we
    // never persist an auth-error turn and never relay the loop-inducing text.
    if (looksLikeAuthError(res.text)) {
      const hint = active.kind === 'cli'
        ? `${active.label} is signed out. Run "holt login ${active.id}" (or add an API key with "holt setting").`
        : `${active.label} is signed out. Run "holt setting" to add or fix its API key.`;
      return { ok: false, text: hint, brainLabel: active.label };
    }

    if (res.ok && opts.store !== false) {
      const now = Date.now();
      appendTurn({ id: randomUUID().slice(0, 8), ts: now, session: runSession, role: 'user', content: task, emb: (await embed(task)) ?? undefined });
      appendTurn({ id: randomUUID().slice(0, 8), ts: now, session: runSession, role: 'assistant', content: res.text, emb: (await embed(res.text)) ?? undefined });
    }

    return { ok: res.ok, text: res.text, brainLabel: active.label };
  } catch (e) {
    return { ok: false, text: (e as Error).message, brainLabel: '' };
  }
}
