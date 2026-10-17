#!/usr/bin/env node
// Lints skills/*/SKILL.md: parseable frontmatter, non-empty name + description,
// semver version, folder/name agreement, referenced files exist, no em-dashes.
// Run: node scripts/lint-skills.mjs   (exit 1 on any problem)
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { listSkillFolders, parseStrict, SEMVER, finish } from './lib-skills.mjs';

const errors = [];
const skills = listSkillFolders();
if (skills.length === 0) errors.push('no skills found under skills/');

for (const s of skills) {
  const tag = `skills/${s.folder}`;
  if (s.raw === null) { errors.push(`${tag}: missing SKILL.md`); continue; }
  const fm = parseStrict(s.raw);
  if (!fm.ok) { errors.push(`${tag}: ${fm.error}`); continue; }
  if (!fm.data.name) errors.push(`${tag}: frontmatter "name" is missing or empty`);
  else if (fm.data.name !== s.folder) errors.push(`${tag}: name "${fm.data.name}" does not match folder`);
  if (!fm.data.description) errors.push(`${tag}: frontmatter "description" is missing or empty`);
  if (!fm.data.version) errors.push(`${tag}: frontmatter "version" is missing`);
  else if (!SEMVER.test(fm.data.version)) errors.push(`${tag}: version "${fm.data.version}" is not x.y.z`);
  if (!fm.body.trim()) errors.push(`${tag}: empty body`);
  if (s.raw.includes('\u2014')) errors.push(`${tag}: contains an em-dash`);

  // Referenced files: markdown links to relative targets, and backticked paths
  // that start with a known resource folder or ./
  const refs = new Set();
  for (const m of fm.body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const t = m[1].split('#')[0];
    if (t && !/^[a-z][a-z0-9+.-]*:/i.test(t)) refs.add(t);
  }
  for (const m of fm.body.matchAll(/`((?:\.\/|references\/|scripts\/|assets\/|templates\/)[^`\s]+)`/g)) refs.add(m[1]);
  for (const r of refs) {
    const target = resolve(s.dir, r);
    if (!target.startsWith(s.dir + sep)) errors.push(`${tag}: reference "${r}" escapes the skill folder`);
    else if (!existsSync(target)) errors.push(`${tag}: referenced file "${r}" does not exist`);
  }
}
finish(`lint-skills (${skills.length} skills)`, errors);
