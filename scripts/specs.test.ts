/**
 * Unit-style checks for src/specs.ts. Run with: npx tsx scripts/specs.test.ts
 * Zero test framework: assert from node:assert, exit non-zero on failure.
 */
import assert from 'node:assert/strict';
import { recommendLocalModel, detect } from '../src/specs';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log('ok - ' + name);
}

check('8 GB discourages local, still names llama3.2:3b', () => {
  const r = recommendLocalModel(8);
  assert.equal(r.local, false);
  assert.equal(r.model, 'llama3.2:3b');
});

check('16 GB recommends qwen2.5:7b with llama3.1:8b alt', () => {
  const r = recommendLocalModel(16);
  assert.equal(r.local, true);
  assert.equal(r.model, 'qwen2.5:7b');
  assert.equal(r.alt, 'llama3.1:8b');
});

check('32 GB recommends qwen2.5:14b', () => {
  const r = recommendLocalModel(32);
  assert.equal(r.local, true);
  assert.equal(r.model, 'qwen2.5:14b');
});

check('24 GB (tier floor) recommends qwen2.5:14b', () => {
  const r = recommendLocalModel(24);
  assert.equal(r.model, 'qwen2.5:14b');
});

check('64 GB recommends qwen2.5:32b', () => {
  const r = recommendLocalModel(64);
  assert.equal(r.local, true);
  assert.equal(r.model, 'qwen2.5:32b');
});

check('48 GB (tier floor) recommends qwen2.5:32b', () => {
  const r = recommendLocalModel(48);
  assert.equal(r.model, 'qwen2.5:32b');
});

check('0 / unknown RAM degrades to the small tier without throwing', () => {
  const r = recommendLocalModel(0);
  assert.equal(r.local, false);
  assert.equal(typeof r.note, 'string');
});

check('detect() returns a well-shaped object and never throws', () => {
  const s = detect();
  assert.equal(typeof s.platform, 'string');
  assert.equal(typeof s.arch, 'string');
  assert.equal(typeof s.cpuModel, 'string');
  assert.equal(typeof s.cpuCount, 'number');
  assert.equal(typeof s.totalRamGB, 'number');
  assert.equal(typeof s.freeRamGB, 'number');
  assert.ok(s.nodeVersion.length > 0);
});

console.log(`\n${passed} checks passed.`);
