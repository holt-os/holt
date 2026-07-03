/**
 * Shared task runner: the non-interactive engine behind `holt run`, scheduled
 * jobs, and the Telegram bot. It resolves the brain, recalls relevant memory,
 * builds a prompt, runs the brain once, and (optionally) stores the exchange
 * back to memory. The selected brain executes the task; the local model is only
 * used for memory. This stub is replaced on feat/auto-run; other branches
 * compile against this signature.
 */

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

export async function runTask(_task: string, _opts: RunOptions = {}): Promise<RunResult> {
  throw new Error('runTask not implemented yet');
}
