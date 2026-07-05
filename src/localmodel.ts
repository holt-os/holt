/**
 * Local generative model client (Ollama /api/generate). This is a SEPARATE
 * concern from the embed model in memory.ts: embeddings are always local and
 * free, but a generative "maintainer" for the wiki is optional and slower. Zero
 * dependencies (global fetch only). Never throws: failures come back as
 * { ok: false, text }, matching the brain adapters' shape.
 */

const OLLAMA_URL = process.env.HOLT_OLLAMA_URL || 'http://127.0.0.1:11434';

export interface LocalResult {
  ok: boolean;
  text: string;
}

/**
 * Is a local Ollama reachable at all, and does it have the given model pulled?
 * Returns a small status object so callers can print the right hint (start
 * Ollama vs. `ollama pull <model>`). Never throws.
 */
export async function localModelStatus(
  model: string,
): Promise<{ reachable: boolean; hasModel: boolean }> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { reachable: false, hasModel: false };
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    // Ollama tags carry an implicit :latest; match on the bare name too.
    const want = model.includes(':') ? model : `${model}:latest`;
    const hasModel = !!data.models?.some((m) => {
      const n = m.name || '';
      return n === model || n === want || n.startsWith(`${model}:`);
    });
    return { reachable: true, hasModel };
  } catch {
    return { reachable: false, hasModel: false };
  }
}

/**
 * Generate a completion from a local Ollama model. Non-streaming (we want the
 * whole page text back before writing it). `timeoutMs` is generous because a 7B
 * model on CPU is slow. Never throws.
 */
export async function localGenerate(
  model: string,
  prompt: string,
  timeoutMs = 120000,
): Promise<LocalResult> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, text: `Could not reach local Ollama at ${OLLAMA_URL}: ${(e as Error).message}` };
  }
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    return { ok: false, text: `Ollama error ${res.status}: ${body.slice(0, 200)}` };
  }
  try {
    const data = (await res.json()) as { response?: string };
    const text = (data.response || '').trim();
    if (text) return { ok: true, text };
    return { ok: false, text: 'Local model returned an empty reply.' };
  } catch (e) {
    return { ok: false, text: `Could not parse Ollama reply: ${(e as Error).message}` };
  }
}

/** The command a user runs to fetch a missing model. */
export function pullHint(model: string): string {
  return `ollama pull ${model}`;
}
