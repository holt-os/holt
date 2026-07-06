#!/usr/bin/env node
/**
 * A deterministic fake "brain" for wiki smoke tests. It stands in for a real
 * agent CLI: invoked as `fake-brain.mjs [args...] "<prompt>"`, it inspects the
 * prompt and prints a plausible reply on stdout, exit 0.
 *
 * Two modes, keyed off text in the prompt:
 *  - Page synthesis ("Updated page body:"): emit a synthesized body for the
 *    titled page, echoing the new facts as prose, with a "## Related" section.
 *  - Lint ("auditing a personal knowledge wiki"): emit a short 3-part report.
 *  - Fact extraction ("JSON array:"): emit a JSON array (used if wired to facts).
 */
const prompt = process.argv[process.argv.length - 1] || '';

function titleOf(p) {
  const m = p.match(/titled "([^"]+)"/);
  return m ? m[1] : 'Notes';
}
function factsOf(p) {
  const idx = p.indexOf('New facts to integrate:');
  if (idx < 0) return [];
  const tail = p.slice(idx);
  const end = tail.indexOf('\n\nUpdated page body:');
  const block = end >= 0 ? tail.slice(0, end) : tail;
  return block
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.trim().slice(2));
}

// Lint --fix: the prompt asks us to RETURN every page between markers, fixing
// issues. We echo each page back, but for any page whose body contains the
// sentinel "DUPLICATE_LINE" we drop that line (simulating a de-dup fix), so the
// applied file provably changes.
if (/Fix quality issues across the pages/i.test(prompt)) {
  const BEGIN = '<<<HOLT-PAGE ';
  const END = '<<<HOLT-END>>>';
  const out = [];
  let i = 0;
  while (true) {
    const b = prompt.indexOf(BEGIN, i);
    if (b < 0) break;
    const slugStart = b + BEGIN.length;
    const slugEnd = prompt.indexOf('>>>', slugStart);
    if (slugEnd < 0) break;
    const slug = prompt.slice(slugStart, slugEnd).trim();
    const bodyStart = slugEnd + 3;
    const end = prompt.indexOf(END, bodyStart);
    if (end < 0) break;
    let body = prompt.slice(bodyStart, end).trim();
    // De-dup fix: remove any line that contains the DUPLICATE_LINE sentinel.
    body = body
      .split('\n')
      .filter((l) => !l.includes('DUPLICATE_LINE'))
      .join('\n')
      .trim();
    out.push(`${BEGIN}${slug}>>>\n${body}\n${END}`);
    i = end + END.length;
  }
  process.stdout.write(out.join('\n\n') + '\n');
  process.exit(0);
}

if (/auditing a personal knowledge wiki/i.test(prompt)) {
  process.stdout.write(
    'CONTRADICTIONS: none found.\n' +
      'DUPLICATES: none obvious.\n' +
      'GAPS: consider linking related pages more densely.\n',
  );
  process.exit(0);
}

if (/JSON array:\s*$/i.test(prompt) || /extract 1 to 5 durable facts/i.test(prompt)) {
  process.stdout.write('["A durable synthesized fact for testing purposes."]\n');
  process.exit(0);
}

// Default: page synthesis.
const title = titleOf(prompt);
const facts = factsOf(prompt);

// Link to the first "other existing page" the prompt offered, so inter-page
// [[links]] form (proves wikilink edges in the graph). Falls back to none.
function firstOtherTitle(p) {
  const idx = p.indexOf('Other existing pages you may link to:');
  if (idx < 0) return null;
  const tail = p.slice(idx);
  const line = tail.split('\n').find((l) => l.trim().startsWith('- '));
  return line ? line.trim().slice(2).trim() : null;
}
const other = firstOtherTitle(prompt);
const related = other ? `- [[${other}]]\n` : '- (no related pages yet)\n';

const body =
  `# ${title}\n\n` +
  (facts.length
    ? facts.map((f) => `- ${f}`).join('\n')
    : 'Synthesized notes for this topic.') +
  `\n\n## Related\n${related}`;
process.stdout.write(body + '\n');
process.exit(0);
