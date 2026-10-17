#!/usr/bin/env node
// READ-ONLY preview: which locally installed skills would an update of the
// built-in set touch? Compares skills/ in this checkout (the upstream copy)
// against ~/.holt/skills and ./.holt/skills. Never writes, never merges.
// Usage: node scripts/skill-update-preview.mjs [--workspace <dir>]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listSkillFolders, parseStrict, SEMVER, compareSemver } from './lib-skills.mjs';

const wsArg = process.argv.indexOf('--workspace');
const ws = wsArg > -1 ? process.argv[wsArg + 1] : process.cwd();
const scopes = [['global', join(homedir(), '.holt', 'skills')], ['workspace', join(ws, '.holt', 'skills')]];

function files(dir, prefix = '') {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === '.git') return [];
    return statSync(p).isDirectory() ? files(p, prefix + f + '/') : [prefix + f];
  }).sort();
}
function same(a, b) {
  const fa = files(a), fb = files(b);
  return fa.join('\n') === fb.join('\n') && fa.every((f) => readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
}
const ver = (dir) => {
  const v = parseStrict(readFileSync(join(dir, 'SKILL.md'), 'utf8')).data.version;
  return v && SEMVER.test(v) ? v : null;
};

let touched = 0;
for (const up of listSkillFolders()) {
  if (up.raw === null) continue;
  for (const [scope, root] of scopes) {
    const local = join(root, up.folder);
    if (!existsSync(join(local, 'SKILL.md'))) continue;
    if (same(up.dir, local)) { console.log(`  unchanged   [${scope}] ${up.folder}`); continue; }
    const lv = ver(local), uv = ver(up.dir);
    const kind = lv && uv && compareSemver(lv, uv) < 0 ? 'outdated (upstream is newer)' : 'CUSTOMIZED (differs from upstream, update would overwrite)';
    console.log(`  ${kind.startsWith('CUST') ? 'TOUCHES    ' : 'would update'} [${scope}] ${up.folder}  local=${lv || '?'} upstream=${uv || '?'}  ${kind}`);
    touched++;
  }
}
console.log(`\n${touched} installed skill(s) differ from upstream. Read-only: nothing was changed. Merge by hand.`);
