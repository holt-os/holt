/** Brain adapters: shell out to an installed agent CLI in non-interactive mode. */
import { spawn, spawnSync } from 'node:child_process';
import type { BrainConfig } from './config';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** Is a command available on PATH? */
export function isInstalled(command: string): boolean {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(finder, [command], { stdio: 'ignore' });
  return res.status === 0;
}

/**
 * Render the whole conversation into a single prompt so context survives a
 * brain switch. Holt owns the transcript; the underlying CLI is stateless here.
 */
export function renderPrompt(history: Turn[], message: string): string {
  if (history.length === 0) return message;
  const lines = history.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`);
  lines.push(`User: ${message}`);
  return [
    'You are continuing an ongoing conversation. Below is the transcript so far.',
    'Read it for context and reply only as the assistant to the final User message.',
    '',
    lines.join('\n\n'),
    '',
    'Assistant:',
  ].join('\n');
}

export interface BrainResult {
  ok: boolean;
  text: string;
}

/** Run one turn against a brain CLI. Resolves with the reply or an error message. */
export function runBrain(brain: BrainConfig, prompt: string): Promise<BrainResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(brain.command, [...brain.args, prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, text: `Could not launch "${brain.command}": ${(e as Error).message}` });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, text: `Could not run "${brain.command}": ${e.message}` }));
    child.on('close', (code) => {
      const text = out.trim();
      if (code === 0 && text) resolve({ ok: true, text });
      else resolve({ ok: false, text: err.trim() || text || `"${brain.command}" exited with code ${code}` });
    });
  });
}
