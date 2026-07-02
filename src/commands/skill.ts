/**
 * `holt skill <sub>`: manage SKILL.md skills for this folder or your account.
 * Trust-gated like every command that touches the filesystem. Skills are prompt
 * text only; nothing here executes skill content.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
  cpSync,
  mkdtempSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ensureTrusted } from '../workspace';
import { c, createReader } from '../ui';
import {
  listSkills,
  loadSkill,
  parseFrontmatter,
  sanitizeName,
  skillsRoot,
  type SkillScope,
} from '../skills';

function usage(): void {
  console.log(c.dim([
    '',
    '  ' + c.accent('holt skill') + c.dim(' - manage SKILL.md skills'),
    '',
    '  holt skill list                     list installed skills',
    '  holt skill show <name>              print a skill',
    '  holt skill create <name> [--global] scaffold a new skill',
    '  holt skill add <source> [--global]  install from a git URL or local path',
    '  holt skill remove <name>            delete a skill',
    '',
    '  --global installs into ~/.holt/skills (available in every folder).',
    '  Without it, skills live in this folder at ./.holt/skills.',
    '',
  ].join('\n')));
}

const SKILL_TEMPLATE = (name: string): string =>
  [
    '---',
    `name: ${name}`,
    'description: One sentence on what this skill does and when to use it.',
    '---',
    '',
    `# ${name}`,
    '',
    '## When to use',
    '',
    'Describe the situations where this skill applies.',
    '',
    '## Instructions',
    '',
    '1. Step one.',
    '2. Step two.',
    '3. Step three.',
    '',
    '## Example',
    '',
    'Show a short example of the skill in action.',
    '',
  ].join('\n');

/** Does `s` look like a git remote rather than a local path? */
function isGitUrl(s: string): boolean {
  return s.includes('://') || s.endsWith('.git') || s.startsWith('git@');
}

/**
 * Find the SKILL.md for a fetched source: either at the root, or in exactly one
 * immediate subdirectory. Returns the folder that contains SKILL.md, or null.
 */
function findSkillDir(root: string): string | null {
  if (existsSync(join(root, 'SKILL.md'))) return root;
  let subs: string[] = [];
  try {
    subs = readdirSync(root).filter((f) => {
      try {
        return statSync(join(root, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
  const withSkill = subs.filter((f) => existsSync(join(root, f, 'SKILL.md')));
  if (withSkill.length === 1) return join(root, withSkill[0]!);
  return null;
}

function cmdList(): void {
  const skills = listSkills();
  if (skills.length === 0) {
    console.log(c.dim('\n  No skills yet. Create one with "holt skill create <name>".\n'));
    return;
  }
  const nameW = Math.max(4, ...skills.map((s) => s.name.length));
  const scopeW = Math.max(5, ...skills.map((s) => s.scope.length));
  console.log('\n' + c.accent('Skills') + c.dim('  (workspace shadows global on name clash)'));
  console.log(
    '  ' +
      c.dim('name'.padEnd(nameW)) +
      '  ' +
      c.dim('scope'.padEnd(scopeW)) +
      '  ' +
      c.dim('description'),
  );
  for (const s of skills) {
    const desc = s.description.length > 68 ? s.description.slice(0, 67) + '…' : s.description;
    console.log(
      '  ' +
        c.bold(s.name.padEnd(nameW)) +
        '  ' +
        (s.scope === 'workspace' ? c.cyan(s.scope.padEnd(scopeW)) : c.dim(s.scope.padEnd(scopeW))) +
        '  ' +
        (desc || c.dim('(no description)')),
    );
  }
  console.log(c.dim('\n  holt skill show <name>   print a skill'));
  console.log(c.dim('  In chat: /skill <name> [input]   run a skill\n'));
}

function cmdShow(name?: string): void {
  if (!name) { console.log(c.dim('\n  Usage: holt skill show <name>\n')); return; }
  const loaded = loadSkill(name);
  if (!loaded) { console.log(c.dim(`\n  No skill named "${sanitizeName(name)}". Try "holt skill list".\n`)); return; }
  const { skill, body } = loaded;
  console.log('\n' + c.accent(skill.name) + c.dim(`  (${skill.scope})`));
  if (skill.description) console.log('  ' + skill.description);
  console.log(c.dim('  ' + join(skill.dir, 'SKILL.md')));
  console.log('');
  console.log(c.dim(body));
  console.log('');
}

function cmdCreate(name: string | undefined, global: boolean): void {
  const clean = sanitizeName(name || '');
  if (!clean) { console.log(c.dim('\n  Usage: holt skill create <name> [--global]\n')); return; }
  const scope: SkillScope = global ? 'global' : 'workspace';
  const dir = join(skillsRoot(scope), clean);
  if (existsSync(dir)) {
    console.log(c.red(`\n  A ${scope} skill named "${clean}" already exists.`));
    console.log(c.dim('  ' + dir + '\n'));
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), SKILL_TEMPLATE(clean), 'utf8');
  console.log(c.green(`\n  Created ${scope} skill "${clean}".`));
  console.log(c.dim('  ' + join(dir, 'SKILL.md')));
  console.log(c.dim('  Edit it, then run it in chat with "/skill ' + clean + '".\n'));
}

function cmdAdd(source: string | undefined, global: boolean): void {
  if (!source) { console.log(c.dim('\n  Usage: holt skill add <git-url|path> [--global]\n')); return; }
  const scope: SkillScope = global ? 'global' : 'workspace';

  let fetched = ''; // directory holding the fetched source
  let tempDir = ''; // temp dir to clean up (empty if none)
  try {
    if (isGitUrl(source)) {
      tempDir = mkdtempSync(join(tmpdir(), 'holt-skill-'));
      console.log(c.dim(`\n  Cloning ${source} ...`));
      const res = spawnSync('git', ['clone', '--depth', '1', source, tempDir], { stdio: 'ignore' });
      if (res.status !== 0) {
        console.log(c.red('  Clone failed. Check the URL and that git is installed.\n'));
        return;
      }
      fetched = tempDir;
    } else {
      fetched = resolve(source);
      if (!existsSync(fetched)) {
        console.log(c.red(`\n  No such path: ${fetched}\n`));
        return;
      }
    }

    const skillDir = findSkillDir(fetched);
    if (!skillDir) {
      console.log(c.red('\n  Could not find a SKILL.md at the source root or in a single subfolder.\n'));
      return;
    }

    // Name comes from frontmatter, then folder, then sanitized fallback.
    let skillName = '';
    try {
      const { data } = parseFrontmatter(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'));
      skillName = sanitizeName(data.name || '');
    } catch {
      skillName = '';
    }
    if (!skillName) skillName = sanitizeName(skillDir.split(/[\\/]/).pop() || '');
    if (!skillName) { console.log(c.red('\n  Could not determine a valid skill name.\n')); return; }

    const dest = join(skillsRoot(scope), skillName);
    if (existsSync(dest)) {
      console.log(c.red(`\n  A ${scope} skill named "${skillName}" already exists.`));
      console.log(c.dim('  ' + dest + '\n'));
      return;
    }

    mkdirSync(skillsRoot(scope), { recursive: true });
    cpSync(skillDir, dest, { recursive: true });
    // Do not carry a nested .git into the installed skill.
    const nestedGit = join(dest, '.git');
    if (existsSync(nestedGit)) rmSync(nestedGit, { recursive: true, force: true });

    console.log(c.green(`\n  Installed ${scope} skill "${skillName}".`));
    console.log(c.dim('  ' + join(dest, 'SKILL.md') + '\n'));
  } finally {
    if (tempDir && existsSync(tempDir)) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

async function cmdRemove(name: string | undefined, ask: (q: string) => Promise<string | null>): Promise<void> {
  const clean = sanitizeName(name || '');
  if (!clean) { console.log(c.dim('\n  Usage: holt skill remove <name>\n')); return; }
  // Workspace first, then global.
  const wsDir = join(skillsRoot('workspace'), clean);
  const globalDir = join(skillsRoot('global'), clean);
  const target = existsSync(wsDir) ? wsDir : existsSync(globalDir) ? globalDir : '';
  if (!target) { console.log(c.dim(`\n  No skill named "${clean}" found.\n`)); return; }
  const scope = target === wsDir ? 'workspace' : 'global';
  const a = ((await ask(`\n  Delete ${scope} skill "${clean}"? [y/N] `)) ?? '').trim().toLowerCase();
  if (a === 'y' || a === 'yes') {
    rmSync(target, { recursive: true, force: true });
    console.log(c.green('  Removed.\n'));
  } else {
    console.log(c.dim('  Kept.\n'));
  }
}

/** Entry point. `sub` is the subcommand; `rest` are its arguments (flags allowed). */
export async function skillCmd(sub?: string, rest: string[] = []): Promise<void> {
  const { ask, close } = createReader();
  if (!(await ensureTrusted(ask))) { close(); return; }

  const global = rest.includes('--global');
  const args = rest.filter((a) => a !== '--global');
  const action = (sub || '').toLowerCase();

  try {
    switch (action) {
      case 'list':
      case 'ls':
        cmdList();
        break;
      case 'show':
      case 'view':
        cmdShow(args[0]);
        break;
      case 'create':
      case 'new':
        cmdCreate(args[0], global);
        break;
      case 'add':
      case 'install':
        cmdAdd(args[0], global);
        break;
      case 'remove':
      case 'rm':
      case 'delete':
        await cmdRemove(args[0], ask);
        break;
      default:
        usage();
    }
  } finally {
    close();
  }
}
