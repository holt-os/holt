/**
 * `holt write "<what to write>"`: draft content in the user's voice while
 * avoiding AI-tell writing. It composes three things into one prompt: the voice
 * profile (from ~/.holt/voice.json), a generic anti-AI rubric, and the task.
 * Then it runs the folder's default brain. An optional second brain pass checks
 * the draft against the rubric and fixes violations, skippable with --fast.
 *
 * With no profile the command still works with a generic, plain voice. Output
 * goes to stdout and, if --out is given, to a file. The draft is em-dash free.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTask } from '../runner';
import { isTrusted, ensureTrusted } from '../workspace';
import { loadVoice, voicePromptBlock } from '../voice';
import { antiAiPromptBlock, antiAiCheckInstruction, scanAntiAi, stripEmDash } from '../antiai';
import { c, createReader } from '../ui';

type WriteType = 'linkedin' | 'email' | 'tweet' | 'blog' | 'generic';

const TYPES: WriteType[] = ['linkedin', 'email', 'tweet', 'blog', 'generic'];

/** Length and format shaping per type. */
const TYPE_SHAPE: Record<WriteType, string> = {
  linkedin: 'Format: a LinkedIn post. Keep it tight, a few short paragraphs. No hashtag wall.',
  email: 'Format: an email. Include a subject line, then a short body. Plain and direct.',
  tweet: 'Format: a single short post under 280 characters. One clear idea.',
  blog: 'Format: a short blog post with a title and a few paragraphs. No "conclusion" header.',
  generic: 'Format: whatever best fits the request. Keep it concise unless asked otherwise.',
};

const USAGE = [
  '  holt write "<what to write>" [options]',
  '',
  '  Draft content in your saved writing voice, with anti-AI checks.',
  '',
  '  options:',
  '    --type <t>   linkedin | email | tweet | blog | generic (default generic)',
  '    --out <file> also write the draft to a file (relative to this folder)',
  '    --brain <id> use a specific brain (CLI or API brain id)',
  '    --fast       skip the anti-AI self-check second pass',
  '',
  '  example: holt write "a linkedin post about shipping Holt" --type linkedin',
  '',
  '  Tip: build your voice first with "holt voice". Without it, a plain voice is used.',
].join('\n');

interface Parsed {
  task: string;
  type: WriteType;
  out?: string;
  brainId?: string;
  fast: boolean;
}

function parseArgs(args: string[]): Parsed {
  const words: string[] = [];
  let type: WriteType = 'generic';
  let out: string | undefined;
  let brainId: string | undefined;
  let fast = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--type') {
      const t = (args[++i] ?? '').toLowerCase();
      if ((TYPES as string[]).includes(t)) type = t as WriteType;
      continue;
    }
    if (a === '--out') { out = args[++i]; continue; }
    if (a === '--brain') { brainId = args[++i]; continue; }
    if (a === '--fast') { fast = true; continue; }
    words.push(a);
  }
  return { task: words.join(' ').trim(), type, out, brainId, fast };
}

/** Compose the generation prompt: anti-AI rules + voice + shaping + the ask. */
function buildWritePrompt(p: Parsed, voiceBlock: string): string {
  const parts: string[] = [antiAiPromptBlock(), ''];
  if (voiceBlock) {
    parts.push(voiceBlock, '');
  } else {
    parts.push('No saved voice profile. Write in a plain, natural, first-person voice.', '');
  }
  parts.push(TYPE_SHAPE[p.type], '');
  parts.push('Write the following. Output ONLY the finished piece, no preamble and no notes:');
  parts.push(p.task);
  return parts.join('\n');
}

export async function write(args: string[]): Promise<void> {
  const p = parseArgs(args);

  if (!p.task) {
    console.log(USAGE);
    return;
  }

  // Trust gate, same contract as `holt run`.
  if (!isTrusted()) {
    if (process.stdin.isTTY) {
      const { ask, close } = createReader();
      const ok = await ensureTrusted(ask);
      close();
      if (!ok) return;
    } else {
      process.stderr.write('This folder is not trusted. Run holt init or holt chat here once first.\n');
      process.exitCode = 1;
      return;
    }
  }

  const v = loadVoice();
  const voiceBlock = voicePromptBlock(v);
  if (!v || (!v.style && v.samples.length === 0 && v.answers.every((a) => !a.answer.trim()))) {
    process.stderr.write(c.dim('No voice profile found, using a plain voice. Build one with "holt voice".') + '\n');
  }

  const prompt = buildWritePrompt(p, voiceBlock);

  // First pass: generate. We do not store this to memory (it is content output,
  // not a durable fact), and we do not stream so we can run the check pass.
  const gen = await runTask(prompt, { brainId: p.brainId, recall: false, store: false });
  if (!gen.ok) {
    process.stderr.write(c.red(gen.text) + '\n');
    process.exitCode = 1;
    return;
  }

  let draft = gen.text;

  // Optional second pass: self-check against the rubric and fix violations.
  if (!p.fast) {
    const flagsBefore = scanAntiAi(draft);
    const checkPrompt = [
      antiAiCheckInstruction(),
      voiceBlock ? '\n' + voiceBlock : '',
      '\nDRAFT:',
      draft,
    ].join('\n');
    const checked = await runTask(checkPrompt, { brainId: p.brainId, recall: false, store: false });
    if (checked.ok && checked.text.trim()) {
      // Only accept the revision if it did not get worse on the hard scan.
      const flagsAfter = scanAntiAi(checked.text);
      if (flagsAfter.length <= flagsBefore.length) draft = checked.text;
    }
  }

  // Hard guard: the output MUST be em-dash free regardless of what the model did.
  draft = stripEmDash(draft).trimEnd();

  process.stdout.write(draft + '\n');

  if (p.out) {
    const target = resolve(process.cwd(), p.out);
    try {
      writeFileSync(target, draft + '\n', 'utf8');
      process.stderr.write(c.dim(`saved to ${target}`) + '\n');
    } catch (e) {
      process.stderr.write(c.red(`Could not write ${target}: ${(e as Error).message}`) + '\n');
      process.exitCode = 1;
    }
  }
}
