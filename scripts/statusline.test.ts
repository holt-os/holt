/**
 * Checks for the Claude Code status line renderer in src/commands/statusline.ts.
 * Run with: npx tsx scripts/statusline.test.ts
 */
import assert from 'node:assert/strict';
import { renderStatusLine, contextBar } from '../src/commands/statusline';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log('ok - ' + name);
}

const payload = {
  workspace: { current_dir: '/Users/dee/aios' },
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  context_window: { used_percentage: 8.4, context_window_size: 200000 },
};

check('empty / malformed payloads degrade to the bare marker', () => {
  assert.equal(renderStatusLine({}), 'Holt');
  assert.equal(renderStatusLine(null), 'Holt');
  assert.equal(renderStatusLine('garbage'), 'Holt');
});

check('full payload renders folder, branch, model and context bar', () => {
  assert.equal(
    renderStatusLine(payload, { branch: 'main' }),
    'Holt · aios (main) · Opus 5.5 · [█░░░░░░░░░░░░░░░░░░░] 8%',
  );
});

check('no branch drops the parenthetical', () => {
  assert.equal(
    renderStatusLine(payload),
    'Holt · aios · Opus 5.5 · [█░░░░░░░░░░░░░░░░░░░] 8%',
  );
});

check('missing context shows an empty bar, not a crash', () => {
  const { context_window: _, ...rest } = payload;
  assert.equal(renderStatusLine(rest), 'Holt · aios · Opus 5.5 · [░░░░░░░░░░░░░░░░░░░░] --');
});

check('context derived from token usage when used_percentage is absent', () => {
  const p = {
    ...payload,
    context_window: {
      context_window_size: 200000,
      current_usage: { input_tokens: 50000, cache_read_input_tokens: 50000 },
    },
  };
  assert.match(renderStatusLine(p), /\] 50%$/);
});

check('contextBar clamps and fills one cell per 5%', () => {
  assert.equal(contextBar(0), `[${'░'.repeat(20)}] 0%`);
  assert.equal(contextBar(100), `[${'█'.repeat(20)}] 100%`);
  assert.equal(contextBar(undefined), `[${'░'.repeat(20)}] --`);
});

check('color mode wraps segments in ANSI and still resets', () => {
  const out = renderStatusLine(payload, { color: true });
  assert.ok(out.includes('\x1b[1;34maios\x1b[0m'));
  assert.ok(out.endsWith('\x1b[0m'));
});

console.log(`\n${passed} passed`);
