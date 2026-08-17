/**
 * `holt tour`: a three-step guided first win for people who have never used a
 * terminal tool before. Ends on the remember-moment: teach Holt one fact, see
 * it recalled, learn that it survives closing the terminal. Every step
 * degrades gracefully (no brain -> memory-only tour), because a first-timer
 * hitting a wall here would be the worst possible introduction.
 */
import { loadConfig } from '../config';
import { runTask } from '../runner';
import { saveFact, recall, newSessionId, memStats } from '../memory';
import { ensureTrusted } from '../workspace';
import { c, createReader } from '../ui';

function step(n: number, title: string): void {
  console.log('\n' + c.accent(`Step ${n} of 3`) + c.bold(`  ${title}`));
}

export async function tour(): Promise<void> {
  const { ask, close } = createReader();
  try {
    if (!(await ensureTrusted(ask))) return;
    const cfg = loadConfig();
    if (!cfg || !cfg.defaultBrain) {
      console.log(c.dim('\n  This folder is not set up yet. Run "holt" once, then come back for the tour.\n'));
      return;
    }

    console.log('\n' + c.bold('Welcome. This takes two minutes and shows you the one thing that matters.'));

    // Step 1: ask about the folder. Skipped without fuss if the brain is not
    // ready (signed out, offline): the tour's real payoff is steps 2 and 3.
    step(1, 'Ask about your files');
    console.log(c.dim('  Holt reads the folder it runs in. Asking it what it sees here...\n'));
    const r = await runTask(
      'Look at the files in this folder and describe, in two short plain sentences, what this folder seems to be about. If it is empty or nearly empty, say that cheerfully.',
      { store: false, onChunk: (t) => process.stdout.write(t) },
    );
    if (!r.ok) {
      console.log(c.dim('  (Your brain is not reachable right now, so we will skip this step. The next two work offline.)'));
      if (r.text) console.log(c.dim(`  ${r.text.trim()}`));
    }
    console.log('');

    // Step 2: teach it one fact.
    step(2, 'Teach Holt one thing about you');
    console.log(c.dim('  Type one fact you want Holt to keep. Examples: "I run a bakery in Pune",'));
    console.log(c.dim('  "My big project this quarter is the Delhi launch", "I hate long emails".\n'));
    let fact = ((await ask('  Your fact: ')) ?? '').trim();
    if (!fact) fact = 'I just finished the Holt tour.';
    const session = newSessionId();
    await saveFact(fact, session);
    console.log(c.green('\n  Kept.') + c.dim('  That went into this folder’s memory, on this laptop, nowhere else.'));

    // Step 3: watch it come back.
    step(3, 'Watch it remember');
    console.log(c.dim('  Asking Holt’s memory: "what do you know about me?"...\n'));
    const hits = await recall('what do you know about me? who am I? my work', '__tour__', 4);
    const shown = hits.filter((h) => h.turn.content.trim().length > 0).slice(0, 3);
    if (shown.length === 0) {
      console.log('  ' + c.accent('remembered') + `  ${fact}`);
    } else {
      for (const h of shown) {
        console.log('  ' + c.accent('remembered') + `  ${h.turn.content.slice(0, 110).replace(/\s+/g, ' ')}`);
      }
    }
    const s = memStats();
    console.log(
      '\n' +
        c.bold('  Here is the point: ') +
        'close this terminal. Come back tomorrow, or next month, and ask again.\n' +
        `  Still there. This folder now holds ${s.turns} memor${s.turns === 1 ? 'y' : 'ies'}, and every chat adds more.\n`,
    );
    console.log(c.dim('  Next: run "holt" to start a real conversation, or "holt help" to see everything it does.\n'));
  } finally {
    close();
  }
}
