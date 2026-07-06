/**
 * `holt voice`: run or redo the writing-style interview and manage the voice
 * profile. Subcommands:
 *   holt voice            run the interview (pick depth, or ingest samples)
 *   holt voice add <file> ingest a writing sample from a file
 *   holt voice show       print the profile
 *   holt voice edit       explain where voice.json lives (it is human-editable)
 *   holt voice clear      remove the profile
 *
 * Privacy is a hard rule: the interview only ever asks about writing and
 * communication style. It never asks for name, job, location, or life details.
 * If the user volunteers such info in an answer, it is stored verbatim and no
 * follow-up is asked. Writing samples are stored only with explicit consent.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { c, createReader, type Ask } from '../ui';
import {
  loadVoice,
  saveVoice,
  clearVoice,
  emptyVoice,
  voicePath,
  makeSample,
  synthesizeVoice,
  type VoiceProfile,
  type InterviewAnswer,
  type StyleProfile,
} from '../voice';

// ---- interview questions ----

interface Question {
  key: string;
  q: string;
  depth: 'quick' | 'detailed';
}

/** Style-only questions. Nothing personal. "quick" is a subset of the whole set. */
const QUESTIONS: Question[] = [
  { key: 'tone', q: 'What tone do you want to sound like? (casual / professional / playful / dry, or describe it)', depth: 'quick' },
  { key: 'sentences', q: 'Short punchy sentences, longer flowing ones, or a mix?', depth: 'quick' },
  { key: 'person', q: 'Do you write in first person ("I"), third person, or a mix?', depth: 'quick' },
  { key: 'emoji', q: 'Emoji: never, rarely, or freely? Any you like or ban?', depth: 'quick' },
  { key: 'banned', q: 'Any words or phrases you love, and any you never want used?', depth: 'quick' },
  { key: 'audience', q: 'Who do you usually write for? (e.g. peers, customers, a general audience)', depth: 'detailed' },
  { key: 'formatting', q: 'Formatting habits: short paragraphs, headers, bullet lists, plain prose?', depth: 'detailed' },
  { key: 'soundsLike', q: 'Name a writer, publication, or vibe you want to sound like.', depth: 'detailed' },
  { key: 'avoid', q: 'What do you NOT want to sound like? (e.g. corporate, salesy, robotic)', depth: 'detailed' },
  { key: 'signature', q: 'Any signature moves? (openings you like, how you end, humor, analogies)', depth: 'detailed' },
];

/**
 * Skip/cancel intent at an entry or depth prompt. Case-insensitive, trimmed.
 * `null` (EOF) also counts as skip. Empty string means "no, skip" here, which
 * is why this guard is only used at cancel-friendly prompts (not inside the
 * question loop, where empty means "skip this one question").
 */
function isSkip(a: string | null): boolean {
  if (a === null) return true;
  const s = a.trim().toLowerCase();
  return s === '' || s === 'n' || s === 'no' || s === 'skip' || s === 'cancel' || s === 'q' || s === 'quit';
}

/** Print the standard skip notice and return. Writes nothing to disk. */
function skipNotice(): void {
  console.log(c.dim('\n  Skipped. Run ') + c.accent('holt voice') + c.dim(' anytime.\n'));
}

/**
 * Ask the depth up front. Empty means the "quick" default (a genuine path).
 * An explicit skip/cancel word or EOF returns null so the caller can abort.
 */
async function askDepth(ask: Ask): Promise<'quick' | 'detailed' | null> {
  const a = await ask('Depth? "quick" (a few questions) or "detailed" (more): [quick] ');
  if (a === null) return null; // EOF
  const s = a.trim().toLowerCase();
  // Explicit cancel words abort; empty is the quick default, not a skip here.
  if (s === 'n' || s === 'no' || s === 'skip' || s === 'cancel' || s === 'q' || s === 'quit') return null;
  return s === 'detailed' || s === 'd' ? 'detailed' : 'quick';
}

/** Run the question set for a depth, collecting answers. Stops early on EOF. */
async function runQuestions(ask: Ask, depth: 'quick' | 'detailed'): Promise<InterviewAnswer[]> {
  const set = QUESTIONS.filter((q) => depth === 'detailed' || q.depth === 'quick');
  const out: InterviewAnswer[] = [];
  console.log(c.dim('\n  Answer in your own words. Press enter to skip any question.\n'));
  for (const q of set) {
    const a = await ask('  ' + q.q + '\n  > ');
    if (a === null) break; // EOF
    out.push({ key: q.key, question: q.q, answer: a.trim() });
  }
  return out;
}

// ---- sample ingestion ----

/** Ask whether to keep an excerpt of a sample (consent). Defaults to no. */
async function askKeepExcerpt(ask: Ask): Promise<boolean> {
  const a = ((await ask('  Store a short excerpt so Holt can match your tone directly? [y/N] ')) ?? '').trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

/** Ingest a file into the profile as a sample. Returns updated profile or null. */
async function addFileSample(ask: Ask | null, file: string, v: VoiceProfile): Promise<VoiceProfile | null> {
  const path = resolve(process.cwd(), file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(c.red(`  Could not read ${path}: ${(e as Error).message}`));
    return null;
  }
  if (!text.trim()) {
    console.error(c.red(`  ${path} is empty.`));
    return null;
  }
  const keep = ask ? await askKeepExcerpt(ask) : true; // non-interactive add keeps an excerpt
  v.samples.push(makeSample('file:' + path, text, keep));
  console.log(c.green(`  Added sample from ${path}`) + c.dim(` (${text.length} chars${keep ? ', excerpt stored' : ', hash only'})`));
  return v;
}

/** Read a pasted multi-line sample terminated by a line with just "." or EOF. */
async function pasteSample(ask: Ask, v: VoiceProfile): Promise<VoiceProfile | null> {
  console.log(c.dim('  Paste your writing sample. End with a single "." on its own line.'));
  const lines: string[] = [];
  for (;;) {
    const line = await ask('');
    if (line === null) break; // EOF
    if (line.trim() === '.') break;
    lines.push(line);
  }
  const text = lines.join('\n').trim();
  if (!text) {
    console.log(c.dim('  Nothing pasted, skipping.'));
    return null;
  }
  const keep = await askKeepExcerpt(ask);
  v.samples.push(makeSample('paste', text, keep));
  console.log(c.green('  Sample added.') + c.dim(` (${text.length} chars${keep ? ', excerpt stored' : ', hash only'})`));
  return v;
}

// ---- rendering ----

function printStyle(s: StyleProfile): void {
  const row = (label: string, val?: string | number | string[]) => {
    if (val === undefined || (Array.isArray(val) && val.length === 0)) return;
    const shown = Array.isArray(val) ? val.join(', ') : String(val);
    console.log(`  ${c.dim(label.padEnd(16))} ${shown}`);
  };
  row('tone', s.tone);
  row('formality', typeof s.formality === 'number' ? `${s.formality}/5` : undefined);
  row('sentence len', s.avgSentenceLength);
  row('person', s.person);
  row('emoji', s.emoji);
  row('formatting', s.formatting);
  row('signature', s.signatureMoves);
  row('banned', s.bannedWords);
  row('audience', s.targetAudiences);
  row('sounds like', s.soundsLike);
  row('not like', s.doesNotSoundLike);
}

function showProfile(v: VoiceProfile): void {
  console.log('\n' + c.accent('Your writing voice') + c.dim('  (' + voicePath() + ')'));
  if (v.depth) console.log(c.dim(`  interview depth: ${v.depth}`));
  console.log(c.dim(`  answers: ${v.answers.filter((a) => a.answer.trim()).length}   samples: ${v.samples.length}`));
  if (v.style) {
    console.log('');
    printStyle(v.style);
  } else if (v.synthesisNote) {
    console.log('\n  ' + c.dim(v.synthesisNote));
  } else {
    console.log('\n  ' + c.dim('No synthesized profile yet.'));
  }
  console.log('');
}

// ---- top-level command ----

const USAGE = [
  '  holt voice [subcommand]',
  '',
  '  (no subcommand)   run the writing-style interview and build your profile',
  '  add <file>        add a writing sample from a file',
  '  show              print your voice profile',
  '  edit              show where voice.json lives (it is human-editable)',
  '  clear             remove your voice profile',
  '',
  '  The interview only asks about writing and communication style.',
  '  It never asks for personal details. Your profile lives at ~/.holt/voice.json.',
].join('\n');

export async function voice(sub?: string, args: string[] = []): Promise<void> {
  switch (sub) {
    case 'show':
      return voiceShow();
    case 'add':
      return voiceAdd(args[0]);
    case 'edit':
      return voiceEdit();
    case 'clear':
      return voiceClear();
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      return;
    case undefined:
      return voiceInterview();
    default:
      console.error(c.red(`  Unknown voice subcommand: "${sub}"`));
      console.log(USAGE);
      process.exitCode = 1;
  }
}

/** Run (or redo) the interview, then synthesize a profile. */
export async function voiceInterview(): Promise<void> {
  const { ask, close } = createReader();
  const existing = loadVoice();
  const v = existing ?? emptyVoice();

  console.log('\n' + c.accent('Teach Holt your writing voice'));
  console.log(c.dim('  Style only. No personal questions. You can do the interview, share samples, or both.\n'));

  const modeRaw = await ask('Do the [i]nterview, add [s]amples, or [b]oth? [i] ');
  // Skip/cancel at the entry prompt aborts cleanly and writes nothing.
  if (isSkip(modeRaw)) { close(); skipNotice(); return; }
  const mode = (modeRaw ?? '').trim().toLowerCase();
  const wantInterview = mode === 'i' || mode === 'b' || mode === 'interview' || mode === 'both';
  const wantSamples = mode === 's' || mode === 'b' || mode === 'samples' || mode === 'both';
  // An unrecognized non-skip answer defaults to the interview (old behavior).
  const wantInterviewOrDefault = wantInterview || !wantSamples;

  if (wantInterviewOrDefault) {
    const depth = await askDepth(ask);
    // Skip/cancel at the depth prompt also aborts without writing a profile.
    if (depth === null) { close(); skipNotice(); return; }
    v.depth = depth;
    const answers = await runQuestions(ask, depth);
    // Merge: replace answers for keys we just asked, keep any older ones.
    const askedKeys = new Set(answers.map((a) => a.key));
    v.answers = [...v.answers.filter((a) => !askedKeys.has(a.key)), ...answers];
  }

  if (wantSamples) {
    for (;;) {
      const how = ((await ask('\n  Add a sample from a [f]ile or [p]aste it? (enter to finish): ')) ?? '').trim().toLowerCase();
      if (how === '' || how === 'q' || how === 'n' || how === 'done') break;
      if (how === 'f' || how === 'file') {
        const fp = await ask('  File path: ');
        if (fp === null) break;
        if (fp.trim()) await addFileSample(ask, fp.trim(), v);
      } else if (how === 'p' || how === 'paste') {
        await pasteSample(ask, v);
      } else {
        console.log(c.dim('  Type f, p, or press enter to finish.'));
      }
    }
  }

  // Release stdin before the (streaming-capable) brain call.
  close();

  // Nothing meaningful was gathered (no real answers, no samples). Do not
  // synthesize a junk profile from an empty interview, and write nothing.
  const gotAnswers = v.answers.some((a) => a.answer.trim());
  if (!gotAnswers && v.samples.length === 0) {
    skipNotice();
    return;
  }

  saveVoice(v);
  console.log(c.dim('\n  Building your style profile from a brain...'));
  const synthed = await synthesizeVoice(v);
  saveVoice(synthed);

  if (synthed.style) {
    console.log(c.green('  Style profile ready.'));
    printStyle(synthed.style);
  } else if (synthed.synthesisNote) {
    console.log('  ' + c.dim(synthed.synthesisNote));
  }
  console.log(c.dim(`\n  Saved to ${voicePath()}`));
  console.log(c.dim('  Draft in this voice with:  ') + c.accent('holt write "..."') + '\n');
}

export async function voiceShow(): Promise<void> {
  const v = loadVoice();
  if (!v) {
    console.log(c.dim('\n  No voice profile yet. Run ') + c.accent('holt voice') + c.dim(' to create one.\n'));
    return;
  }
  showProfile(v);
}

export async function voiceAdd(file?: string): Promise<void> {
  if (!file) {
    console.log(c.dim('  Usage: holt voice add <file>'));
    process.exitCode = 1;
    return;
  }
  const v = loadVoice() ?? emptyVoice();
  const updated = await addFileSample(null, file, v);
  if (!updated) {
    process.exitCode = 1;
    return;
  }
  saveVoice(updated);
  console.log(c.dim('  Refreshing style profile...'));
  const synthed = await synthesizeVoice(updated);
  saveVoice(synthed);
  if (synthed.synthesisNote) console.log('  ' + c.dim(synthed.synthesisNote));
  else console.log(c.green('  Profile updated.'));
}

export async function voiceEdit(): Promise<void> {
  const path = voicePath();
  const v = loadVoice();
  if (!v) {
    console.log(c.dim(`\n  No profile yet. Run "holt voice" first. It will be written to:\n    ${path}\n`));
    return;
  }
  console.log('\n' + c.accent('Your voice profile is a plain JSON file you can edit by hand:'));
  console.log('  ' + path);
  console.log(c.dim('  Open it in any editor. Keys: answers, samples, style (tone, formality, bannedWords, ...).'));
  console.log(c.dim('  After hand-editing "answers" or "samples", run "holt voice" to re-synthesize the style.\n'));
}

export async function voiceClear(): Promise<void> {
  const had = clearVoice();
  console.log(had ? c.green('\n  Voice profile removed.\n') : c.dim('\n  No voice profile to remove.\n'));
}
