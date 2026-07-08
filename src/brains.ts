/** Brain adapters: shell out to an installed agent CLI in non-interactive mode. */
import { spawn, spawnSync } from 'node:child_process';
import type { BrainConfig } from './config';
import type { Recalled } from './memory';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** How many recent turns get replayed verbatim. Older context returns via memory recall. */
export const MAX_REPLAY_TURNS = 12;

/** Is a command available on PATH? */
export function isInstalled(command: string): boolean {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(finder, [command], { stdio: 'ignore' });
  return res.status === 0;
}

/**
 * Render the conversation into a single prompt so context survives a brain
 * switch. Live history is capped; relevant older moments come from memory.
 */
export function renderPrompt(history: Turn[], message: string, memory: Recalled[] = []): string {
  const recent = history.slice(-MAX_REPLAY_TURNS);
  const parts: string[] = [];

  if (recent.length || memory.length) {
    parts.push(
      "You are the user's assistant, running through Holt, a tool that gives you durable memory of this user across sessions. Notes recalled from their past sessions may appear below; use them naturally and answer as their assistant.",
      'You are continuing an ongoing conversation. Use the context below and reply only as the assistant to the final User message.',
    );
  }

  if (memory.length) {
    parts.push(
      '',
      "Relevant notes from this user's earlier sessions:",
      ...memory.map((m) => `- (${m.turn.role}) ${m.turn.content.slice(0, 500)}`),
    );
  }

  if (recent.length) {
    parts.push('', 'Transcript so far:', ...recent.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`));
  }

  if (parts.length === 0) return message;

  parts.push('', `User: ${message}`, '', 'Assistant:');
  return parts.join('\n');
}

export interface BrainResult {
  ok: boolean;
  text: string;
}

/**
 * Run one turn against a brain CLI. Streams stdout chunks through onChunk as
 * they arrive and resolves with the full reply.
 *
 * `extraArgs` are inserted BEFORE the prompt (after the brain's own args), so
 * callers can pass per-session flags such as Claude Code's `--add-dir=<dir>` for
 * permission-gated access to folders outside the workspace. It defaults to [] so
 * existing callers are unaffected. NOTE: the flags must be self-contained tokens
 * (use the `--flag=value` form, not `--flag value`), because some CLI options
 * are variadic and would otherwise swallow the trailing prompt positional.
 */
export function runBrain(
  brain: BrainConfig,
  prompt: string,
  onChunk?: (chunk: string) => void,
  extraArgs: string[] = [],
): Promise<BrainResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(brain.command, [...brain.args, ...extraArgs, prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, text: `Could not launch "${brain.command}": ${(e as Error).message}` });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (onChunk) onChunk(s);
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => resolve({ ok: false, text: `Could not run "${brain.command}": ${e.message}` }));
    child.on('close', (code) => {
      const text = out.trim();
      if (code === 0 && text) resolve({ ok: true, text });
      else resolve({ ok: false, text: err.trim() || text || `"${brain.command}" exited with code ${code}` });
    });
  });
}
