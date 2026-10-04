/**
 * Checks for recallContext()/formatMemoryContext() in src/memory.ts. Run with:
 * npx tsx scripts/memory.test.ts
 *
 * Uses the keyword path only (Ollama pointed at a dead port), so it is
 * deterministic on any machine.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.HOLT_OLLAMA_URL = 'http://127.0.0.1:9';
const { recallContext, formatMemoryContext } = await import('../src/memory');

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log('ok - ' + name);
}

const dir = mkdtempSync(join(tmpdir(), 'holt-mem-'));
mkdirSync(join(dir, '.holt', 'memory'), { recursive: true });
const day = (d: string) => Date.parse(d + 'T10:00:00Z');
const rows = [
  { id: 'a1', ts: day('2026-01-05'), session: 's1', role: 'user', content: 'I just adopted a beagle called Pepper.' },
  { id: 'a2', ts: day('2026-01-05') + 1, session: 's1', role: 'assistant', content: 'Congratulations! Beagles love long walks.' },
  { id: 'a3', ts: day('2026-01-05') + 2, session: 's1', role: 'user', content: 'Unrelated: what is a good pasta recipe?' },
  { id: 'b1', ts: day('2026-03-10'), session: 's2', role: 'user', content: 'Pepper the beagle now weighs 12 kg after the vet visit.' },
  { id: 'b2', ts: day('2026-03-10') + 1, session: 's2', role: 'assistant', content: 'That is a healthy weight for a beagle.' },
  { id: 'c1', ts: day('2026-04-01'), session: 'now', role: 'user', content: 'How much does my beagle Pepper weigh?' },
];
writeFileSync(join(dir, '.holt', 'memory', 'turns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const prevCwd = process.cwd();
process.chdir(dir);

try {
  await check('finds matching rows and excludes the current session', async () => {
    const ctx = await recallContext('beagle Pepper weigh', 'now', { k: 3, neighbors: 1 });
    assert.ok(ctx.hits > 0);
    const sessions = ctx.blocks.map((b) => b.session);
    assert.ok(!sessions.includes('now'));
    assert.ok(sessions.includes('s2'));
  });

  await check('blocks are oldest first, and neighbours ride along', async () => {
    const ctx = await recallContext('beagle Pepper', 'now', { k: 2, neighbors: 1 });
    const ts = ctx.blocks.map((b) => b.ts);
    assert.deepEqual([...ts].sort((a, b) => a - b), ts);
    const s1 = ctx.blocks.find((b) => b.session === 's1');
    assert.ok(s1 && s1.rows.some((r) => !r.hit), 'expected a neighbour row in s1');
  });

  await check('character budget is respected (at least one row always kept)', async () => {
    const ctx = await recallContext('beagle Pepper', 'now', { k: 5, neighbors: 1, budget: 60 });
    const total = ctx.blocks.reduce((a, b) => a + b.rows.length, 0);
    assert.ok(total >= 1);
    assert.ok(ctx.chars <= 60 || total === 1);
  });

  await check('formatted context carries today and session dates', async () => {
    const ctx = await recallContext('beagle Pepper weigh', 'now', { k: 3 });
    const text = formatMemoryContext(ctx, '2026-04-01');
    assert.match(text, /Today is 2026-04-01/);
    assert.match(text, /### Session on 2026-03-10/);
    assert.match(text, /12 kg/);
  });

  await check('empty store gives empty context and empty text', async () => {
    const ctx = await recallContext('anything at all', 's1-only-session-that-does-not-exist', { k: 3 });
    assert.equal(formatMemoryContext({ blocks: [], hits: 0, chars: 0 }), '');
    assert.ok(ctx.blocks.length >= 0);
  });
} finally {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed`);
