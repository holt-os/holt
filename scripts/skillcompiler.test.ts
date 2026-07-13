/**
 * Unit-style checks for src/skillcompiler.ts. Run with:
 *   npx tsx scripts/skillcompiler.test.ts
 * Zero test framework: assert from node:assert, exit non-zero on failure.
 *
 * Isolation: each check runs in a throwaway temp workspace (chdir there so
 * workspace() == cwd resolves to it) with HOME pointed at a temp dir (so the
 * global Codex prompts dir ~/.codex/prompts is also throwaway). Skills are
 * created as WORKSPACE skills under <ws>/.holt/skills, which listSkills() picks
 * up via the current working directory.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log('ok - ' + name);
}

/** Make a fresh temp workspace + temp HOME, chdir into the workspace, and return
 * both paths. Callers must import the compiler AFTER this so homedir()/cwd read
 * the temp values (the module reads them lazily per call, so ordering is safe). */
function freshEnv(): { ws: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'holt-compiler-'));
  const ws = join(root, 'ws');
  const home = join(root, 'home');
  mkdirSync(ws, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.chdir(ws);
  return { ws, home };
}

/** Write a workspace skill <ws>/.holt/skills/<name>/SKILL.md (+ optional extra files). */
function makeSkill(
  ws: string,
  name: string,
  description: string,
  body: string,
  extraFiles: Record<string, string> = {},
): void {
  const dir = join(ws, '.holt', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const md = ['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join('\n');
  writeFileSync(join(dir, 'SKILL.md'), md, 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

// Import after we know how we will drive cwd/HOME. The module reads cwd()/homedir()
// per call, so a single import is fine for all checks.
const {
  compileForBrain,
  removeSkillArtifacts,
} = await import('../src/skillcompiler.ts');

// ---------------------------------------------------------------------------

check('claude: skill folder is copied verbatim (multi-file preserved)', () => {
  const { ws } = freshEnv();
  makeSkill(ws, 'demo', 'A demo skill.', '# demo\nDo the thing.', {
    'ref/notes.md': 'reference material',
  });
  const res = compileForBrain('claude', ws);
  const dest = join(ws, '.claude', 'skills', 'demo');
  assert.ok(existsSync(join(dest, 'SKILL.md')), 'SKILL.md copied');
  assert.ok(existsSync(join(dest, 'ref', 'notes.md')), 'multi-file preserved');
  assert.equal(readFileSync(join(dest, 'ref', 'notes.md'), 'utf8'), 'reference material');
  assert.ok(res.written.includes(dest), 'reported as written');
});

check('gemini: emits TOML with description + prompt + {{args}}', () => {
  const { ws } = freshEnv();
  makeSkill(ws, 'demo', 'A demo skill.', 'Follow these steps carefully.');
  compileForBrain('gemini', ws);
  const dest = join(ws, '.gemini', 'commands', 'demo.toml');
  assert.ok(existsSync(dest), 'toml written');
  const toml = readFileSync(dest, 'utf8');
  assert.ok(toml.includes('description = "A demo skill."'), 'description field');
  assert.ok(toml.includes('prompt = """'), 'prompt multiline field');
  assert.ok(toml.includes('{{args}}'), 'gemini args placeholder');
  assert.ok(toml.includes('holt-managed skill: demo'), 'ownership marker');
});

check('codex: emits GLOBAL markdown prompt with $ARGUMENTS + frontmatter', () => {
  const { ws, home } = freshEnv();
  makeSkill(ws, 'demo', 'A demo skill.', 'Follow these steps carefully.');
  compileForBrain('codex', ws);
  const dest = join(home, '.codex', 'prompts', 'holt-demo.md');
  assert.ok(existsSync(dest), 'codex prompt written to global ~/.codex/prompts');
  const md = readFileSync(dest, 'utf8');
  assert.ok(md.startsWith('---'), 'yaml frontmatter');
  assert.ok(md.includes('description: A demo skill.'), 'description');
  assert.ok(md.includes('argument-hint:'), 'argument-hint');
  assert.ok(md.includes('$ARGUMENTS'), 'codex args placeholder');
  assert.ok(md.includes('holt-managed skill: demo'), 'ownership marker');
});

check('non-clobber: a user-authored gemini command is NOT overwritten', () => {
  const { ws } = freshEnv();
  makeSkill(ws, 'demo', 'A demo skill.', 'Body.');
  const dest = join(ws, '.gemini', 'commands', 'demo.toml');
  mkdirSync(join(dest, '..'), { recursive: true });
  writeFileSync(dest, 'prompt = "MINE"\n', 'utf8'); // user's own, no marker
  const res = compileForBrain('gemini', ws);
  assert.equal(readFileSync(dest, 'utf8'), 'prompt = "MINE"\n', 'user file untouched');
  assert.ok(res.skippedExisting.includes(dest), 'reported skipped');
});

check('non-clobber: a user-authored claude skill folder is NOT overwritten', () => {
  const { ws } = freshEnv();
  makeSkill(ws, 'demo', 'A demo skill.', 'Body.');
  const dest = join(ws, '.claude', 'skills', 'demo');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'SKILL.md'), 'USER OWNED', 'utf8'); // pre-existing, not ours
  const res = compileForBrain('claude', ws);
  assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'USER OWNED', 'user folder untouched');
  assert.ok(res.skippedExisting.includes(dest), 'reported skipped');
});

check('idempotent: a second compile with no change writes nothing', () => {
  const { ws } = freshEnv();
  makeSkill(ws, 'demo', 'A demo skill.', 'Body.');
  compileForBrain('gemini', ws);
  const res2 = compileForBrain('gemini', ws);
  assert.equal(res2.written.length, 0, 'nothing rewritten');
  assert.equal(res2.removed.length, 0, 'nothing removed');
  assert.equal(res2.skippedExisting.length, 0, 'nothing skipped');
});

check('manifest cleanup: removeSkillArtifacts deletes ONLY Holt output', () => {
  const { ws } = freshEnv();
  makeSkill(ws, 'demo', 'A demo skill.', 'Body.');
  makeSkill(ws, 'keep', 'Keep me.', 'Body.');
  compileForBrain('claude', ws);
  compileForBrain('gemini', ws);
  const claudeDemo = join(ws, '.claude', 'skills', 'demo');
  const geminiDemo = join(ws, '.gemini', 'commands', 'demo.toml');
  const geminiKeep = join(ws, '.gemini', 'commands', 'keep.toml');
  assert.ok(existsSync(claudeDemo) && existsSync(geminiDemo), 'demo compiled');
  // Drop a user file into the compiled claude project dir; it must survive.
  const userFile = join(ws, '.claude', 'skills', 'mine.txt');
  writeFileSync(userFile, 'user data', 'utf8');
  const n = removeSkillArtifacts('demo', ws);
  assert.ok(n >= 2, 'removed both demo artifacts across brains');
  assert.ok(!existsSync(claudeDemo), 'claude demo removed');
  assert.ok(!existsSync(geminiDemo), 'gemini demo removed');
  assert.ok(existsSync(geminiKeep), 'other skill untouched');
  assert.ok(existsSync(userFile), 'user file untouched');
});

check('staleness: disabling a skill removes its stale compiled artifact', () => {
  const { ws } = freshEnv();
  makeSkill(ws, 'demo', 'A demo skill.', 'Body.');
  compileForBrain('gemini', ws);
  const dest = join(ws, '.gemini', 'commands', 'demo.toml');
  assert.ok(existsSync(dest), 'compiled');
  // Remove the source skill, then recompile: the stale artifact should go.
  rmSync(join(ws, '.holt', 'skills', 'demo'), { recursive: true, force: true });
  const res = compileForBrain('gemini', ws);
  assert.ok(!existsSync(dest), 'stale artifact removed');
  assert.ok(res.removed.includes(dest), 'reported removed');
});

check('graceful skip: an empty-body, no-description skill is skipped for gemini', () => {
  const { ws } = freshEnv();
  // SKILL.md with only a name: no description, empty body -> nothing to prompt.
  const dir = join(ws, '.holt', 'skills', 'empty');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), ['---', 'name: empty', '---', ''].join('\n'), 'utf8');
  const res = compileForBrain('gemini', ws);
  const dest = join(ws, '.gemini', 'commands', 'empty.toml');
  assert.ok(!existsSync(dest), 'no broken command emitted');
  assert.ok(res.skippedUnexpressible.includes('empty'), 'reported unexpressible');
});

console.log(`\n${passed} checks passed.`);
