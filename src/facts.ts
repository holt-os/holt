/**
 * Deeper memory loop: at chat session end, ask the active brain to distill a
 * few durable facts from the transcript, then store them via memory.saveFact.
 * One silent brain call, tolerant parsing, never throws. Zero dependencies.
 */
import type { Turn } from './brains';
import { runBrain } from './brains';
import { runApiBrain } from './apibrain';
import type { BrainId, ApiBrain, HoltConfig } from './config';
import { saveFact } from './memory';

/** Below this many user/assistant exchanges we skip extraction entirely. */
export const MIN_EXCHANGES_FOR_EXTRACTION = 3;

/** How many recent turns and characters we hand the brain. */
const MAX_TRANSCRIPT_TURNS = 20;
const MAX_TURN_CHARS = 1000;

/** Build the strict extraction prompt from the tail of the transcript. */
export function buildExtractionPrompt(history: Turn[]): string {
  const recent = history.slice(-MAX_TRANSCRIPT_TURNS);
  const transcript = recent
    .map((t) => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${t.content.slice(0, MAX_TURN_CHARS)}`)
    .join('\n\n');

  const lines = [
    'Given this conversation, extract 1 to 5 durable facts worth remembering long-term.',
    'Output ONLY a JSON array of strings, no prose, no code fences.',
    '',
    'Rules:',
    '- Keep decisions, outcomes, stable preferences, key names, dates, and numbers.',
    '- Skip pleasantries, one-off questions, and generic advice.',
    '- Make each fact self-contained so it reads on its own in a future session.',
    '- If nothing is worth saving, output exactly []',
    '',
    'Good examples:',
    '- "User decided to target the Netherlands as the primary job market, HSM visa route."',
    '- "HDFC EMI is 17,394 rupees per month with 29 payments remaining as of March 2026."',
    '',
    'Bad examples (do NOT output these):',
    '- "User asked a question about their finances."',
    '- "The assistant gave some helpful advice."',
    '',
    'Conversation:',
    transcript,
    '',
    'JSON array:',
  ];
  return lines.join('\n');
}

/**
 * Scan for the first complete top-level JSON array by tracking bracket depth,
 * ignoring brackets inside string literals. Returns the parsed array or null.
 * Never throws.
 */
function firstBalancedArray(s: string): unknown[] | null {
  const start = s.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice);
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Collapse whitespace and lowercase for within-batch dedup. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/, '');
}

/**
 * Parse a brain reply into up to 5 fact strings. Tolerant: strips a code fence,
 * grabs the first JSON array, and never throws.
 */
export function parseFacts(raw: string): string[] {
  let s = (raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];

  let arr: unknown = null;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    // Greedy match can over-reach when extra text trails the array (for example
    // an echo brain that also prints the prompt). Fall back to the first
    // balanced array by scanning bracket depth outside of string literals.
    arr = firstBalancedArray(s);
  }
  if (!Array.isArray(arr)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const v = String(item).trim();
    if (v.length <= 10) continue;
    const key = norm(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * The resolved brain to call for a silent one-shot extraction. For the CLI
 * kind, `commandOverride` lets a caller (the Stop hook, which may run under a
 * reduced PATH) pass an ABSOLUTE path to the brain binary that was resolved out
 * of band; when set it replaces `command` for this one call without mutating the
 * stored config. Omitting it keeps the existing behavior.
 */
type ExtractionBrain =
  | { kind: 'cli'; id: BrainId; commandOverride?: string }
  | { kind: 'api'; brain: ApiBrain };

/**
 * Distill facts from the session transcript and persist them. Returns the count
 * of newly saved facts. Never throws: any failure resolves to 0.
 */
export async function extractAndSaveFacts(
  active: ExtractionBrain,
  cfg: HoltConfig,
  history: Turn[],
  session: string,
): Promise<number> {
  try {
    if (Math.floor(history.length / 2) < MIN_EXCHANGES_FOR_EXTRACTION) return 0;

    const prompt = buildExtractionPrompt(history);

    // One silent call: no onChunk, so nothing streams to the terminal.
    const res = active.kind === 'cli'
      ? await runBrain(
          active.commandOverride
            ? { ...cfg.brains[active.id], command: active.commandOverride }
            : cfg.brains[active.id],
          prompt,
        )
      : await runApiBrain(active.brain, prompt);
    if (!res.ok) return 0;

    const facts = parseFacts(res.text);
    let saved = 0;
    for (const f of facts) {
      if (await saveFact(f, session)) saved++;
    }
    return saved;
  } catch {
    return 0;
  }
}
