/**
 * Phase 3 skills: SKILL.md folders discovered from two roots. Workspace skills
 * live at <folder>/.holt/skills/<name>/SKILL.md; personal (global) skills at
 * ~/.holt/skills/<name>/SKILL.md. Workspace wins on a name collision.
 *
 * A skill is just prompt text. Nothing here executes skill content: an invoked
 * skill's Markdown body is spliced into the model prompt, never run as code.
 * Zero dependencies, so the YAML frontmatter parser is hand-rolled below.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR, wsHoltDir } from './workspace';

export type SkillScope = 'workspace' | 'global';

export interface Skill {
  name: string;
  description: string;
  dir: string;
  scope: SkillScope;
}

/** Folder that holds skills for a given scope. */
export function skillsRoot(scope: SkillScope): string {
  return scope === 'workspace' ? join(wsHoltDir(), 'skills') : join(GLOBAL_DIR, 'skills');
}

/** Lowercase, keep [a-z0-9-]. Used for every path segment derived from a name. */
export function sanitizeName(name: string): string {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/**
 * Parse optional YAML-ish frontmatter fenced by `---` lines at the top of a
 * document. Handles `key: value` pairs with optional single/double quotes.
 * Tolerates a missing fence by returning empty data and the whole input as body.
 */
export function parseFrontmatter(md: string): Frontmatter {
  const text = md.replace(/^﻿/, '');
  const lines = text.split('\n');
  // First non-empty line must be the opening fence, otherwise no frontmatter.
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start++;
  if (start >= lines.length || lines[start]!.trim() !== '---') {
    return { data: {}, body: text.trim() };
  }

  const data: Record<string, string> = {};
  let i = start + 1;
  let closed = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') {
      closed = true;
      i++;
      break;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue; // ignore stray lines (list items, blanks, etc.)
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let value = line.slice(idx + 1).trim();
    // Strip a matching pair of surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    data[key.toLowerCase()] = value;
  }

  if (!closed) {
    // No closing fence: treat the whole thing as body, not frontmatter.
    return { data: {}, body: text.trim() };
  }
  return { data, body: lines.slice(i).join('\n').trim() };
}

/** Read a SKILL.md into a Skill, falling back to folder name + first line. */
function readSkill(dir: string, folder: string, scope: SkillScope): Skill | null {
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) return null;
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const name = sanitizeName(data.name || folder) || folder;
  let description = data.description || '';
  if (!description) {
    const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
    description = firstLine.replace(/^#+\s*/, '');
  }
  return { name, description, dir, scope };
}

/** Every skill folder directly under a scope's root. */
function listScope(scope: SkillScope): Skill[] {
  const root = skillsRoot(scope);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const folder of entries) {
    const dir = join(root, folder);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skill = readSkill(dir, folder, scope);
    if (skill) out.push(skill);
  }
  return out;
}

/**
 * All discoverable skills, sorted by name. On a name collision the workspace
 * copy shadows the global one.
 */
export function listSkills(): Skill[] {
  const byName = new Map<string, Skill>();
  // Global first so workspace overwrites on collision.
  for (const s of listScope('global')) byName.set(s.name, s);
  for (const s of listScope('workspace')) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface LoadedSkill {
  skill: Skill;
  body: string;
}

/** Load one skill by name (workspace wins), returning its body without frontmatter. */
export function loadSkill(name: string): LoadedSkill | null {
  const want = sanitizeName(name);
  const skill = listSkills().find((s) => s.name === want);
  if (!skill) return null;
  let raw = '';
  try {
    raw = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const { body } = parseFrontmatter(raw);
  return { skill, body };
}

/**
 * A short block for prompt injection so the model knows which skills exist and
 * that it should follow one's instructions when the user invokes it. Empty
 * string when there are no skills (so the caller can inject unconditionally).
 */
export function skillsPromptBlock(): string {
  const skills = listSkills();
  if (skills.length === 0) return '';
  const lines = [
    'Skills available to this user (invoked with "/skill <name>"). When the user invokes a skill, follow that skill\'s instructions:',
    ...skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`),
  ];
  return lines.join('\n');
}

export interface SkillInvocation {
  prompt: string;
  skillName: string;
}

/**
 * Turn a "/skill <name> [free text]" line into a runnable prompt: the skill
 * body, an apply line, then the user's input (or a default ask). Returns null
 * when the line is not a skill invocation or the named skill is missing.
 */
export function resolveSkillInvocation(line: string): SkillInvocation | null {
  const trimmed = line.trim();
  const m = trimmed.match(/^\/skill\s+(\S+)\s*([\s\S]*)$/i);
  if (!m) return null;
  const name = m[1]!;
  const input = (m[2] || '').trim();
  const loaded = loadSkill(name);
  if (!loaded) return null;
  const prompt = [
    loaded.body,
    '',
    'Apply the skill above to this request:',
    input || 'Introduce what you can do with this skill.',
  ].join('\n');
  return { prompt, skillName: loaded.skill.name };
}
