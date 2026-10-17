#!/usr/bin/env node
// Fails if a skill changed versus the base ref without bumping its frontmatter
// version. Usage: node scripts/check-skill-versions.mjs [baseRef]
// baseRef defaults to $BASE_REF, then origin/main. If the base cannot be
// resolved (shallow clone, first run) the check is skipped with a notice.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, parseStrict, SEMVER, compareSemver, finish } from './lib-skills.mjs';

const base = process.argv[2] || process.env.BASE_REF || 'origin/main';
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const errors = [];

let mergeBase;
try { mergeBase = git('merge-base', base, 'HEAD').trim(); } catch {
  console.log(`check-skill-versions: base "${base}" not resolvable, skipped`);
  process.exit(0);
}
// Committed changes since the merge base plus uncommitted working-tree changes.
const changed = new Set(
  git('diff', '--name-only', mergeBase, '--', 'skills').split('\n').filter((f) => /^skills\/[^/]+\/.+/.test(f)),
);
const folders = new Set([...changed].map((f) => f.split('/')[1]));
for (const folder of [...folders].sort()) {
  let before = null;
  try { before = git('show', `${mergeBase}:skills/${folder}/SKILL.md`); } catch { /* new skill */ }
  if (before === null) continue; // new skill: nothing to bump
  let after = null;
  try { after = readFileSync(join(ROOT, `skills/${folder}/SKILL.md`), 'utf8'); } catch { /* deleted */ }
  if (after === null) continue;
  const vb = parseStrict(before).data.version;
  const va = parseStrict(after).data.version;
  if (!va || !SEMVER.test(va)) { errors.push(`skills/${folder}: missing or invalid version`); continue; }
  if (vb && SEMVER.test(vb) && compareSemver(va, vb) <= 0) {
    errors.push(`skills/${folder}: changed since ${base} but version is still ${va} (was ${vb}); bump it`);
  }
}
finish(`check-skill-versions (${folders.size} changed vs ${base})`, errors);
