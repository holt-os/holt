// Shared helpers for the skill checks. Plain Node, no dependencies.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = join(ROOT, 'skills');

/** Strict frontmatter parse. Returns { ok, error, data, body }. */
export function parseStrict(md) {
  const lines = md.replace(/^\uFEFF/, '').split('\n');
  if (lines[0].trim() !== '---') return { ok: false, error: 'no opening --- fence on line 1', data: {}, body: md };
  const data = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    if (line.trim() === '' || /^\s+\S/.test(line) || /^\s*-\s/.test(line)) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) return { ok: false, error: `frontmatter line ${i + 1} is not "key: value": ${line}`, data, body: '' };
    let v = line.slice(idx + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    data[line.slice(0, idx).trim().toLowerCase()] = v;
  }
  if (i >= lines.length) return { ok: false, error: 'no closing --- fence', data, body: '' };
  return { ok: true, error: '', data, body: lines.slice(i + 1).join('\n') };
}

/** [{ folder, dir, file, raw }] for every folder under a skills root. */
export function listSkillFolders(root = SKILLS_DIR) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => statSync(join(root, f)).isDirectory())
    .sort()
    .map((folder) => {
      const dir = join(root, folder);
      const file = join(dir, 'SKILL.md');
      return { folder, dir, file, raw: existsSync(file) ? readFileSync(file, 'utf8') : null };
    });
}

export const SEMVER = /^\d+\.\d+\.\d+$/;

export function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export function finish(label, errors) {
  if (errors.length) {
    console.error(`${label}: FAILED`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(`${label}: ok`);
}
