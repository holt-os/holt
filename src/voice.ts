/**
 * Voice profile: how a user writes. Stored GLOBALLY at ~/.holt/voice.json so it
 * follows the user across folders (unlike per-folder config). It holds the raw
 * interview answers, references to writing samples the user chose to share, and
 * a synthesized STYLE PROFILE built by asking the configured brain to analyze
 * the answers and samples into a structured JSON shape.
 *
 * Privacy: only writing and communication style is ever asked for or stored.
 * Samples are stored only with the user's consent (an excerpt plus a hash);
 * otherwise just a hash and length are kept. Nothing here ever throws.
 *
 * Zero dependencies. Reuses the brain-call pattern from runner.ts / facts.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR } from './workspace';
import {
  loadConfig,
  BRAIN_IDS,
  findApiBrain,
  resolveApiKey,
  type BrainId,
  type ApiBrain,
  type HoltConfig,
} from './config';
import { isInstalled, runBrain } from './brains';
import { runApiBrain } from './apibrain';

// ---- types ----

/** One interview question and the user's answer. */
export interface InterviewAnswer {
  key: string; // stable question key
  question: string; // the prompt shown
  answer: string; // what the user typed (may be empty if skipped)
}

/** A writing sample the user shared, for tone anchoring. */
export interface VoiceSample {
  source: string; // "file:<path>" or "paste"
  hash: string; // sha256 of the full text
  length: number; // character count of the full text
  excerpt?: string; // stored only with consent (bounded)
  storedFull: boolean; // did the user consent to keep an excerpt?
  addedAt: number;
}

/** The synthesized, structured style profile. All fields optional and best-effort. */
export interface StyleProfile {
  tone?: string; // e.g. "casual", "professional", "playful, dry"
  formality?: number; // 1 (very casual) .. 5 (very formal)
  avgSentenceLength?: string; // e.g. "short", "medium", "8-14 words"
  person?: string; // "first", "third", "mixed"
  emoji?: string; // "none", "rare", "one per post", etc.
  formatting?: string; // habits: short paragraphs, headers, lists...
  signatureMoves?: string[]; // recurring devices the user likes
  bannedWords?: string[]; // words/phrases to avoid
  targetAudiences?: string[]; // who they write for
  soundsLike?: string; // short summary of the target voice
  doesNotSoundLike?: string; // short summary of what to avoid
}

/** The whole voice profile file. */
export interface VoiceProfile {
  version: number;
  depth?: 'quick' | 'detailed';
  answers: InterviewAnswer[];
  samples: VoiceSample[];
  style?: StyleProfile; // synthesized; absent until a brain runs
  synthesizedAt?: number;
  synthesisNote?: string; // e.g. "no brain configured yet"
  updatedAt: number;
}

const VOICE_VERSION = 1;

export function voicePath(): string {
  return join(GLOBAL_DIR, 'voice.json');
}

export function voiceExists(): boolean {
  return existsSync(voicePath());
}

/** Load the profile, or null if none / unreadable. Never throws. */
export function loadVoice(): VoiceProfile | null {
  try {
    const raw = readFileSync(voicePath(), 'utf8');
    const p = JSON.parse(raw) as Partial<VoiceProfile>;
    return {
      version: VOICE_VERSION,
      depth: p.depth === 'detailed' ? 'detailed' : p.depth === 'quick' ? 'quick' : undefined,
      answers: Array.isArray(p.answers) ? (p.answers as InterviewAnswer[]) : [],
      samples: Array.isArray(p.samples) ? (p.samples as VoiceSample[]) : [],
      style: (p.style as StyleProfile) ?? undefined,
      synthesizedAt: typeof p.synthesizedAt === 'number' ? p.synthesizedAt : undefined,
      synthesisNote: typeof p.synthesisNote === 'string' ? p.synthesisNote : undefined,
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/** An empty profile skeleton. */
export function emptyVoice(): VoiceProfile {
  return { version: VOICE_VERSION, answers: [], samples: [], updatedAt: Date.now() };
}

/** Persist the profile (mode 0o600, it can contain writing excerpts). Never throws. */
export function saveVoice(v: VoiceProfile): boolean {
  try {
    mkdirSync(GLOBAL_DIR, { recursive: true });
    v.version = VOICE_VERSION;
    v.updatedAt = Date.now();
    writeFileSync(voicePath(), JSON.stringify(v, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Remove the profile file. Returns true if a file was there. Never throws. */
export function clearVoice(): boolean {
  try {
    if (!existsSync(voicePath())) return false;
    // Overwrite then unlink so a stray excerpt does not linger on disk.
    writeFileSync(voicePath(), '{}\n', 'utf8');
    rmSync(voicePath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---- samples ----

const MAX_EXCERPT = 1200;

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Build a sample record from raw text. If keepExcerpt is true the user consented
 * to store a bounded excerpt; otherwise only a hash and length are kept.
 */
export function makeSample(source: string, text: string, keepExcerpt: boolean): VoiceSample {
  const clean = text.replace(/\s+$/g, '');
  return {
    source,
    hash: hashText(clean),
    length: clean.length,
    excerpt: keepExcerpt ? clean.slice(0, MAX_EXCERPT) : undefined,
    storedFull: keepExcerpt,
    addedAt: Date.now(),
  };
}

// ---- brain resolution (mirrors runner.resolveActive, default-brain aware) ----

type Active =
  | { kind: 'cli'; id: BrainId }
  | { kind: 'api'; brain: ApiBrain };

/**
 * Resolve the folder's default brain to a callable target, or null if none is
 * configured or reachable. Best-effort, never throws.
 */
export function resolveDefaultBrain(cfg: HoltConfig | null): Active | null {
  if (!cfg || !cfg.defaultBrain) return null;
  const id = cfg.defaultBrain;
  if ((BRAIN_IDS as string[]).includes(id)) {
    const b = cfg.brains[id as BrainId];
    if (b && b.enabled && isInstalled(b.command)) return { kind: 'cli', id: id as BrainId };
    return null;
  }
  const api = findApiBrain(cfg, id);
  if (api && resolveApiKey(api)) return { kind: 'api', brain: api };
  return null;
}

/** Call a resolved brain once with no streaming. Never throws. */
async function callBrain(active: Active, cfg: HoltConfig, prompt: string): Promise<{ ok: boolean; text: string }> {
  try {
    const res =
      active.kind === 'cli'
        ? await runBrain(cfg.brains[active.id], prompt)
        : await runApiBrain(active.brain, prompt);
    return { ok: res.ok, text: res.text };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}

// ---- synthesis ----

/** Build the strict prompt that turns answers + samples into a StyleProfile JSON. */
export function buildSynthesisPrompt(v: VoiceProfile): string {
  const answers = v.answers
    .filter((a) => a.answer.trim())
    .map((a) => `- ${a.question}\n  ANSWER: ${a.answer.trim()}`)
    .join('\n');

  const samples = v.samples
    .map((s, i) => {
      if (s.excerpt) return `Sample ${i + 1} (${s.source}):\n${s.excerpt}`;
      return `Sample ${i + 1} (${s.source}): [not stored, ${s.length} chars]`;
    })
    .join('\n\n');

  return [
    'You are analyzing how a specific person writes so their assistant can draft in their voice.',
    'From the interview answers and any writing samples below, produce a STYLE PROFILE.',
    'Focus ONLY on writing and communication style. Do not infer or invent personal facts',
    '(no name, job, location, or life details), and never add fields beyond the schema.',
    '',
    'Output ONLY a JSON object, no prose and no code fences, with these keys:',
    '{',
    '  "tone": string,               // e.g. "casual, dry"',
    '  "formality": number,          // 1 very casual .. 5 very formal',
    '  "avgSentenceLength": string,  // e.g. "short" or "8-14 words"',
    '  "person": string,             // "first" | "third" | "mixed"',
    '  "emoji": string,              // "none" | "rare" | "one per post" ...',
    '  "formatting": string,         // paragraph, header, and list habits',
    '  "signatureMoves": string[],   // recurring devices they like',
    '  "bannedWords": string[],      // words or phrases to avoid',
    '  "targetAudiences": string[],  // who they write for',
    '  "soundsLike": string,         // one line: what to sound like',
    '  "doesNotSoundLike": string    // one line: what to avoid sounding like',
    '}',
    'If a value is unknown, use an empty string or empty array. Never guess personal info.',
    '',
    answers ? 'INTERVIEW ANSWERS:\n' + answers : 'INTERVIEW ANSWERS: (none)',
    '',
    samples ? 'WRITING SAMPLES:\n' + samples : 'WRITING SAMPLES: (none)',
    '',
    'JSON object:',
  ].join('\n');
}

/** Tolerant parse of a brain reply into a StyleProfile. Never throws. */
export function parseStyleProfile(raw: string): StyleProfile | null {
  let s = (raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  const arr = (x: unknown): string[] | undefined => {
    if (!Array.isArray(x)) return undefined;
    const out = x.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).map((i) => i.trim());
    return out.length ? out : undefined;
  };
  const num = (x: unknown): number | undefined => {
    const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
    return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : undefined;
  };
  const profile: StyleProfile = {
    tone: str(o['tone']),
    formality: num(o['formality']),
    avgSentenceLength: str(o['avgSentenceLength']),
    person: str(o['person']),
    emoji: str(o['emoji']),
    formatting: str(o['formatting']),
    signatureMoves: arr(o['signatureMoves']),
    bannedWords: arr(o['bannedWords']),
    targetAudiences: arr(o['targetAudiences']),
    soundsLike: str(o['soundsLike']),
    doesNotSoundLike: str(o['doesNotSoundLike']),
  };
  // If literally everything is empty, treat as no profile.
  const any = Object.values(profile).some((v) => v !== undefined);
  return any ? profile : null;
}

/**
 * Synthesize (or refresh) the style profile in place using the folder's default
 * brain. If no brain is reachable, leaves style untouched and records a note.
 * Always returns the (possibly updated) profile. Never throws.
 */
export async function synthesizeVoice(v: VoiceProfile): Promise<VoiceProfile> {
  const cfg = loadConfig();
  const active = resolveDefaultBrain(cfg);
  if (!active || !cfg) {
    v.synthesisNote = 'No brain configured yet. Raw answers and samples are saved; run "holt voice" again once a brain is set to build the style profile.';
    return v;
  }
  const prompt = buildSynthesisPrompt(v);
  const res = await callBrain(active, cfg, prompt);
  if (!res.ok) {
    v.synthesisNote = 'Could not reach the brain to synthesize a profile. Raw answers and samples are saved.';
    return v;
  }
  const style = parseStyleProfile(res.text);
  if (!style) {
    v.synthesisNote = 'The brain reply could not be parsed into a style profile. Raw answers and samples are saved.';
    return v;
  }
  v.style = style;
  v.synthesizedAt = Date.now();
  v.synthesisNote = undefined;
  return v;
}

// ---- prompt block for generation ----

/**
 * Render the voice profile into a prompt block for `holt write`. Returns an
 * empty string if there is nothing useful to say (generic voice).
 */
export function voicePromptBlock(v: VoiceProfile | null): string {
  if (!v) return '';
  const s = v.style;
  const lines: string[] = [];

  if (s) {
    lines.push('VOICE PROFILE (write in this voice):');
    if (s.tone) lines.push(`- Tone: ${s.tone}`);
    if (typeof s.formality === 'number') lines.push(`- Formality: ${s.formality}/5 (1 casual, 5 formal)`);
    if (s.avgSentenceLength) lines.push(`- Sentence length: ${s.avgSentenceLength}`);
    if (s.person) lines.push(`- Person: ${s.person}`);
    if (s.emoji) lines.push(`- Emoji: ${s.emoji}`);
    if (s.formatting) lines.push(`- Formatting habits: ${s.formatting}`);
    if (s.signatureMoves?.length) lines.push(`- Signature moves: ${s.signatureMoves.join('; ')}`);
    if (s.bannedWords?.length) lines.push(`- Never use: ${s.bannedWords.join(', ')}`);
    if (s.targetAudiences?.length) lines.push(`- Audience: ${s.targetAudiences.join(', ')}`);
    if (s.soundsLike) lines.push(`- Should sound like: ${s.soundsLike}`);
    if (s.doesNotSoundLike) lines.push(`- Should NOT sound like: ${s.doesNotSoundLike}`);
  }

  // Sample anchoring: a couple of stored excerpts pin the tone better than a
  // description alone (voice-corpus idea: anchor on real text, not adjectives).
  const withExcerpt = v.samples.filter((x) => x.excerpt);
  if (withExcerpt.length) {
    lines.push('', 'WRITING SAMPLES from this person (match this rhythm, do not copy content):');
    for (const smp of withExcerpt.slice(0, 2)) {
      lines.push('"""', (smp.excerpt ?? '').slice(0, 600), '"""');
    }
  }

  // Raw answers help even before synthesis has run.
  if (!s) {
    const ans = v.answers.filter((a) => a.answer.trim());
    if (ans.length) {
      lines.push('', 'The person described their writing style as:');
      for (const a of ans.slice(0, 8)) lines.push(`- ${a.question} ${a.answer.trim()}`);
    }
  }

  return lines.join('\n');
}
