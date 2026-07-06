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
import {
  loadRegistry,
  searchSkills,
  resolveByName,
  buildPublishEntry,
  registryUrl,
  REGISTRY_REPO_URL,
} from '../registry';

function usage(): void {
  console.log(c.dim([
    '',
    '  ' + c.accent('holt skill') + c.dim(' - manage SKILL.md skills'),
    '',
    '  holt skill list                     list installed skills',
    '  holt skill show <name>              print a skill',
    '  holt skill create <name> [--global] scaffold a new skill',
    '  holt skill search <query>           find skills in the registry',
    '  holt skill add <src|name> [--global] install from a git URL, path, or registry name',
    '  holt skill publish [<name>]         prepare a skill for the registry (prints a PR entry)',
    '  holt skill remove <name>            delete a skill',
    '',
    '  --global installs into ~/.holt/skills (available in every folder).',
    '  Without it, skills live in this folder at ./.holt/skills.',
    '  search/add-by-name use the registry (HOLT_REGISTRY_URL or the community index).',
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
  if (!loaded) { console.error(c.dim(`\n  No skill named "${sanitizeName(name)}". Try "holt skill list".\n`)); process.exitCode = 1; return; }
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
    console.error(c.red(`\n  A ${scope} skill named "${clean}" already exists.`));
    console.error(c.dim('  ' + dir + '\n'));
    process.exitCode = 1;
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), SKILL_TEMPLATE(clean), 'utf8');
  console.log(c.green(`\n  Created ${scope} skill "${clean}".`));
  console.log(c.dim('  ' + join(dir, 'SKILL.md')));
  console.log(c.dim('  Edit it, then run it in chat with "/skill ' + clean + '".\n'));
}

/**
 * Install a skill from a source that `holt skill add` already understands: a
 * git URL or a local path. This is the single install path; both direct
 * `add <src>` and registry `add <name>` (after resolving the name to a source)
 * funnel through here, so clone/copy logic is never duplicated. Sets
 * process.exitCode on failure and returns false.
 */
function installFromSource(source: string, scope: SkillScope): boolean {
  let fetched = ''; // directory holding the fetched source
  let tempDir = ''; // temp dir to clean up (empty if none)
  try {
    if (isGitUrl(source)) {
      tempDir = mkdtempSync(join(tmpdir(), 'holt-skill-'));
      console.log(c.dim(`\n  Cloning ${source} ...`));
      const res = spawnSync('git', ['clone', '--depth', '1', source, tempDir], { stdio: 'ignore' });
      if (res.status !== 0) {
        console.error(c.red('  Clone failed. Check the URL and that git is installed.\n'));
        process.exitCode = 1;
        return false;
      }
      fetched = tempDir;
    } else {
      fetched = resolve(source);
      if (!existsSync(fetched)) {
        console.error(c.red(`\n  No such path: ${fetched}\n`));
        process.exitCode = 1;
        return false;
      }
    }

    const skillDir = findSkillDir(fetched);
    if (!skillDir) {
      console.error(c.red('\n  Could not find a SKILL.md at the source root or in a single subfolder.\n'));
      process.exitCode = 1;
      return false;
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
    if (!skillName) { console.error(c.red('\n  Could not determine a valid skill name.\n')); process.exitCode = 1; return false; }

    const dest = join(skillsRoot(scope), skillName);
    if (existsSync(dest)) {
      console.error(c.red(`\n  A ${scope} skill named "${skillName}" already exists.`));
      console.error(c.dim('  ' + dest + '\n'));
      process.exitCode = 1;
      return false;
    }

    mkdirSync(skillsRoot(scope), { recursive: true });
    cpSync(skillDir, dest, { recursive: true });
    // Do not carry a nested .git into the installed skill.
    const nestedGit = join(dest, '.git');
    if (existsSync(nestedGit)) rmSync(nestedGit, { recursive: true, force: true });

    console.log(c.green(`\n  Installed ${scope} skill "${skillName}".`));
    console.log(c.dim('  ' + join(dest, 'SKILL.md') + '\n'));
    return true;
  } finally {
    if (tempDir && existsSync(tempDir)) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * `holt skill add <src|name>`. A git URL or an existing local path installs
 * directly (unchanged behavior). Anything else is treated as a registry skill
 * name: resolve it to a source via the index, then install through the very
 * same path. A name that is neither a URL/path nor in the registry is an error.
 */
async function cmdAdd(source: string | undefined, global: boolean, refresh: boolean): Promise<void> {
  if (!source) { console.log(c.dim('\n  Usage: holt skill add <git-url|path|name> [--global]\n')); return; }
  const scope: SkillScope = global ? 'global' : 'workspace';

  // A URL or an existing path is a direct source: install exactly as before.
  if (isGitUrl(source) || existsSync(resolve(source))) {
    installFromSource(source, scope);
    return;
  }

  // Otherwise resolve <source> as a registry skill name.
  const { registry, error } = await loadRegistry({ refresh });
  if (!registry) {
    console.error(c.red(`\n  "${source}" is not a git URL or a local path, and the registry is unavailable.`));
    console.error(c.dim('  ' + (error || 'no registry reachable') + '\n'));
    process.exitCode = 1;
    return;
  }
  const hit = resolveByName(registry.skills, source);
  if (!hit) {
    console.error(c.red(`\n  No skill named "${source}" in the registry.`));
    console.error(c.dim('  Try "holt skill search ' + source + '" to find one.\n'));
    process.exitCode = 1;
    return;
  }
  console.log(c.dim(`\n  Resolved "${hit.name}" -> ${hit.source}`));
  installFromSource(hit.source, scope);
}

/** `holt skill search <query>`: filter the registry index and print a table. */
async function cmdSearch(query: string, refresh: boolean): Promise<void> {
  const { registry, error, fromCache } = await loadRegistry({ refresh });
  if (!registry) {
    console.error(c.red('\n  Registry unavailable.'));
    console.error(c.dim('  ' + (error || 'no registry reachable') + '\n'));
    process.exitCode = 1;
    return;
  }
  const hits = searchSkills(registry.skills, query);
  if (hits.length === 0) {
    const what = query.trim() ? `matching "${query.trim()}"` : 'in the registry';
    console.log(c.dim(`\n  No skills ${what}.\n`));
    return;
  }

  const nameW = Math.max(4, ...hits.map((s) => s.name.length));
  const authorW = Math.max(6, ...hits.map((s) => (s.author || '').length));
  console.log(
    '\n' + c.accent('Registry') + c.dim('  ' + registryUrl() + (fromCache ? '  (cached)' : '')),
  );
  console.log(
    '  ' +
      c.dim('name'.padEnd(nameW)) +
      '  ' +
      c.dim('author'.padEnd(authorW)) +
      '  ' +
      c.dim('description'),
  );
  for (const s of hits) {
    const desc = s.description.length > 56 ? s.description.slice(0, 55) + '…' : s.description;
    console.log(
      '  ' +
        c.bold(s.name.padEnd(nameW)) +
        '  ' +
        c.dim((s.author || '').padEnd(authorW)) +
        '  ' +
        (desc || c.dim('(no description)')),
    );
    console.log('  ' + ' '.repeat(nameW) + '  ' + ' '.repeat(authorW) + '  ' + c.dim(s.source));
  }
  console.log(c.dim('\n  Install one with "holt skill add <name>".\n'));
}

/**
 * `holt skill publish [<name>]`: validate a skill and print the exact registry
 * JSON entry plus PR instructions. Zero-infra: the user opens a PR to add it;
 * Holt never pushes anywhere. Reads an installed skill by name, or the SKILL.md
 * in the current directory when no name is given.
 */
function cmdPublish(name: string | undefined): void {
  let skillName = '';
  let description = '';
  let sourceHint = '';

  if (name) {
    const loaded = loadSkill(name);
    if (!loaded) {
      console.error(c.red(`\n  No skill named "${sanitizeName(name)}". Try "holt skill list".\n`));
      process.exitCode = 1;
      return;
    }
    // Re-parse the file so name + description come straight from frontmatter.
    let raw = '';
    try {
      raw = readFileSync(join(loaded.skill.dir, 'SKILL.md'), 'utf8');
    } catch {
      console.error(c.red('\n  Could not read the skill\'s SKILL.md.\n'));
      process.exitCode = 1;
      return;
    }
    const { data } = parseFrontmatter(raw);
    skillName = sanitizeName(data.name || loaded.skill.name);
    description = (data.description || loaded.skill.description || '').trim();
  } else {
    // No name: publish the skill in the current directory.
    const file = join(process.cwd(), 'SKILL.md');
    if (!existsSync(file)) {
      console.error(c.red('\n  No SKILL.md in the current directory, and no skill name given.'));
      console.error(c.dim('  Usage: holt skill publish [<name>]\n'));
      process.exitCode = 1;
      return;
    }
    const { data } = parseFrontmatter(readFileSync(file, 'utf8'));
    skillName = sanitizeName(data.name || process.cwd().split(/[\\/]/).pop() || '');
    description = (data.description || '').trim();
    sourceHint = process.cwd();
  }

  if (!skillName || !description) {
    console.error(c.red('\n  This skill is missing a name or description in its SKILL.md frontmatter.'));
    console.error(c.dim('  Both are required to publish. Add:  name: <name>  and  description: <one line>\n'));
    process.exitCode = 1;
    return;
  }

  const entry = buildPublishEntry({
    name: skillName,
    description,
    source: sourceHint || `https://github.com/<you>/${skillName}`,
    author: '<your name or handle>',
    tags: [],
  });

  console.log('\n' + c.accent(`Publish "${skillName}" to the Holt skill registry`));
  console.log(c.dim('  The registry is a git-based JSON index. Publishing = opening a PR that adds your entry.\n'));
  console.log(c.dim('  1. Push this skill to a public git repo (or note a subpath spec Holt can clone).'));
  console.log(c.dim('  2. Add this entry to the "skills" array in registry.json:'));
  console.log('');
  console.log(entry);
  console.log('');
  console.log(c.dim('     Replace the "source" (your public git URL or path) and "author" fields.'));
  console.log(c.dim('  3. Open a pull request against the registry repo:'));
  console.log(c.dim('     ' + REGISTRY_REPO_URL));
  console.log(c.dim('\n  No push happens here. Once merged, anyone can "holt skill add ' + skillName + '".\n'));
}

async function cmdRemove(name: string | undefined, ask: (q: string) => Promise<string | null>): Promise<void> {
  const clean = sanitizeName(name || '');
  if (!clean) { console.log(c.dim('\n  Usage: holt skill remove <name>\n')); return; }
  // Workspace first, then global.
  const wsDir = join(skillsRoot('workspace'), clean);
  const globalDir = join(skillsRoot('global'), clean);
  const target = existsSync(wsDir) ? wsDir : existsSync(globalDir) ? globalDir : '';
  if (!target) { console.error(c.dim(`\n  No skill named "${clean}" found.\n`)); process.exitCode = 1; return; }
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
  const refresh = rest.includes('--refresh');
  const args = rest.filter((a) => a !== '--global' && a !== '--refresh');
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
      case 'search':
      case 'find':
        await cmdSearch(args.join(' '), refresh);
        break;
      case 'add':
      case 'install':
        await cmdAdd(args[0], global, refresh);
        break;
      case 'publish':
        cmdPublish(args[0]);
        break;
      case 'remove':
      case 'rm':
      case 'delete':
        await cmdRemove(args[0], ask);
        break;
      default:
        if (action) process.exitCode = 1; // an explicit but unknown subcommand is an error
        usage();
    }
  } finally {
    close();
  }
}
