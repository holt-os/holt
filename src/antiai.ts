/**
 * Anti-AI writing rubric. A generic, provider-neutral and user-neutral guide
 * that steers a brain away from the patterns that make text read as machine
 * written. It exposes a prompt block to bake into generation, a short checklist,
 * and a lightweight local scan that flags the most mechanical tells (em-dashes,
 * a few stock openers) without any model call. Zero dependencies.
 */

/** The em-dash code point (U+2014). Built from a code point so this source file
 * itself contains no literal em-dash (the repo CI greps for it). */
export const EM_DASH = String.fromCharCode(0x2014);

/**
 * The banned patterns the rubric enforces, as plain guidance lines. Generic on
 * purpose: no personal voice, no company names, no provider specifics.
 */
export const ANTI_AI_RULES: string[] = [
  'No em-dashes anywhere. Use a comma, colon, period, or parentheses instead.',
  'No "rule of three" tricolons or parallel three-beat lists for drama.',
  'No "in today\'s fast-paced world" or "in an era of" style openers.',
  'No "it is not X, it is Y" or "not just X but Y" reframes.',
  'No tidy bow-tie conclusion that restates the thesis in one neat takeaway.',
  'No callback closer where the last line echoes or inverts the opening.',
  'Vary sentence length. Mix short and long. Avoid uniform rhythm.',
  'Prefer concrete specifics, names, and numbers over abstractions.',
  'Cut hedging filler ("it is worth noting", "needless to say", "the truth is").',
  'Avoid corporate buzzwords (leverage, unlock, seamless, robust, holistic, synergy, elevate, streamline, empower, game-changer).',
  'Avoid performed emotion (thrilled, humbled, honored, excited to share).',
  'No emoji unless the voice profile explicitly allows it.',
  'No ALL CAPS for emphasis and no bold on adjectives or adverbs.',
  'Leave at least one thought slightly open. Do not resolve everything neatly.',
  'Write like a person talking to one smart reader, not a press release.',
];

/**
 * Build the anti-AI instruction block to prepend to a generation prompt. Kept
 * compact so it costs few tokens but still names the concrete tells.
 */
export function antiAiPromptBlock(): string {
  return [
    'ANTI-AI WRITING RULES (follow all, they matter):',
    ...ANTI_AI_RULES.map((r) => `- ${r}`),
    '',
    'The single hardest rule: the output must contain zero em-dash characters.',
    'Write plainly. If a sentence sounds like a LinkedIn influencer or a brochure, rewrite it.',
  ].join('\n');
}

/** A one-line self-check instruction for the optional verification pass. */
export function antiAiCheckInstruction(): string {
  return [
    'Review the draft below against these anti-AI rules and the voice profile.',
    'Rewrite any sentence that violates them. Keep the meaning and length similar.',
    'Remove every em-dash. Output ONLY the corrected draft, no commentary.',
    '',
    antiAiPromptBlock(),
  ].join('\n');
}

/** A single flagged issue from the local scan. */
export interface AntiAiFlag {
  rule: string;
  detail: string;
}

/**
 * A cheap, model-free scan for the most mechanical tells. This does not try to
 * judge rhythm or cliches (that is the optional brain pass); it catches the
 * hard, unambiguous ones so we can at least warn. Never throws.
 */
export function scanAntiAi(text: string): AntiAiFlag[] {
  const flags: AntiAiFlag[] = [];
  const t = text || '';

  if (t.includes(EM_DASH)) {
    flags.push({ rule: 'no-em-dash', detail: 'contains an em-dash character' });
  }

  const openers = [
    /in today'?s (fast[- ]paced|ever[- ]changing) world/i,
    /in an era of/i,
    /without further ado/i,
    /let'?s (dive|get started)/i,
  ];
  for (const re of openers) {
    if (re.test(t)) flags.push({ rule: 'stock-opener', detail: `matches ${re.source}` });
  }

  // A small buzzword sniff. Word-boundary matched, case-insensitive.
  const buzz = ['leverage', 'seamless', 'seamlessly', 'unlock', 'game-changer', 'synergy', 'holistic', 'elevate', 'empower', 'streamline'];
  for (const w of buzz) {
    const re = new RegExp(`\\b${w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (re.test(t)) flags.push({ rule: 'buzzword', detail: `uses "${w}"` });
  }

  return flags;
}

/** Strip any em-dash from generated text as a last-resort guard. */
export function stripEmDash(text: string): string {
  return (text || '').split(EM_DASH).join(', ');
}
