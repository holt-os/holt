#!/usr/bin/env node
// Supply-chain guards for the riskiest surfaces. Run: node scripts/security-guards.mjs
//
// These make dangerous changes LOUD, not impossible: a PR that really needs one
// of them must edit the allowlists in this file in the same diff, so the widening
// is explicit and reviewable instead of buried.
//
// Checks:
//  1. .gitignore keeps its secret/personal-data pins and re-includes nothing.
//  2. Committed agent settings (.claude/, .gemini/) have only allowlisted
//     permissions.allow entries and hooks (none are committed today).
//  3. Skills stay prompt-only: no allowed-tools/hooks/permissions frontmatter,
//     no extra files beside SKILL.md, no package.json.
//  4. package.json: no install-time lifecycle scripts, no runtime dependencies,
//     devDependencies only from the allowlist.
//  5. gemini-extension.json mcpServers match the allowlist exactly.
//  6. Which src/ files may spawn processes or touch the network.
//  7. GitHub workflows: no pull_request_target, secrets only from allowlist.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, listSkillFolders, parseStrict, finish } from './lib-skills.mjs';

const errors = [];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const rel = (p) => relative(ROOT, p).split('\\').join('/');

// 1. .gitignore pins -------------------------------------------------------
const REQUIRED_IGNORES = [
  'node_modules/', 'dist/', '.holt/', 'config.yml', '.env', '.env.*', '*.local',
  '.claude/settings.local.json', 'data/', '*.db', '*.sqlite', '*.sqlite3', 'logs/',
];
const ALLOWED_NEGATIONS = new Set([]);
const ignoreLines = read('.gitignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
for (const p of REQUIRED_IGNORES) if (!ignoreLines.includes(p)) errors.push(`.gitignore: required pin "${p}" is missing`);
for (const l of ignoreLines) if (l.startsWith('!') && !ALLOWED_NEGATIONS.has(l)) errors.push(`.gitignore: un-allowlisted negation "${l}"`);

// 2. committed agent settings ---------------------------------------------
const ALLOWED_PERMISSIONS = new Set([]);
const ALLOWED_HOOK_EVENTS = new Set([]);
for (const f of ['.claude/settings.json', '.gemini/settings.json']) {
  if (!existsSync(join(ROOT, f))) continue;
  let j;
  try { j = JSON.parse(read(f)); } catch { errors.push(`${f}: not valid JSON`); continue; }
  for (const p of j.permissions?.allow ?? []) if (!ALLOWED_PERMISSIONS.has(p)) errors.push(`${f}: un-allowlisted permission "${p}"`);
  for (const ev of Object.keys(j.hooks ?? {})) if (!ALLOWED_HOOK_EVENTS.has(ev)) errors.push(`${f}: un-allowlisted hook event "${ev}"`);
}

// 3. skills are prompt-only -----------------------------------------------
const FORBIDDEN_FM = ['allowed-tools', 'allowed_tools', 'allowedtools', 'tools', 'hooks', 'permissions', 'shell', 'command'];
const ALLOWED_EXTRA_FILES = new Set([]); // "skills/<name>/<file>" entries
for (const s of listSkillFolders()) {
  const fm = s.raw === null ? { data: {} } : parseStrict(s.raw);
  for (const k of FORBIDDEN_FM) if (k in fm.data) errors.push(`skills/${s.folder}: frontmatter key "${k}" widens what a skill can do`);
  for (const f of walk(s.dir)) {
    const r = rel(f);
    if (r === `skills/${s.folder}/SKILL.md`) continue;
    if (!ALLOWED_EXTRA_FILES.has(r)) errors.push(`${r}: skills are prompt-only; extra file not allowlisted`);
  }
}

// 4. package.json ----------------------------------------------------------
const pkg = JSON.parse(read('package.json'));
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'prepublish', 'prepublishOnly', 'postpack'];
const ALLOWED_LIFECYCLE = new Set([]);
const ALLOWED_DEPENDENCIES = new Set([]);
const ALLOWED_DEV_DEPENDENCIES = new Set(['tsup', 'tsx', 'typescript', '@types/node']);
for (const k of LIFECYCLE) if (pkg.scripts?.[k] && !ALLOWED_LIFECYCLE.has(k)) errors.push(`package.json: lifecycle script "${k}" runs on install/publish`);
for (const d of Object.keys(pkg.dependencies ?? {})) if (!ALLOWED_DEPENDENCIES.has(d)) errors.push(`package.json: new runtime dependency "${d}"`);
for (const k of ['optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
  if (Object.keys(pkg[k] ?? {}).length) errors.push(`package.json: "${k}" is not allowed`);
}
for (const d of Object.keys(pkg.devDependencies ?? {})) if (!ALLOWED_DEV_DEPENDENCIES.has(d)) errors.push(`package.json: new devDependency "${d}"`);

// 5. gemini-extension.json -------------------------------------------------
const ALLOWED_MCP = { holt: { command: 'npx', args: ['-y', '@holt-os/holt', 'mcp'] } };
if (existsSync(join(ROOT, 'gemini-extension.json'))) {
  const g = JSON.parse(read('gemini-extension.json'));
  for (const [name, def] of Object.entries(g.mcpServers ?? {})) {
    const ok = ALLOWED_MCP[name];
    if (!ok || def.command !== ok.command || JSON.stringify(def.args) !== JSON.stringify(ok.args)) {
      errors.push(`gemini-extension.json: mcpServer "${name}" is not in the allowlist (command/args changed or new server)`);
    }
  }
}

// 6. process and network surface in src/ -----------------------------------
const ALLOWED_SPAWN = new Set([
  'src/brains.ts', 'src/commands/doctor.ts', 'src/commands/graph.ts', 'src/commands/hook.ts',
  'src/commands/schedule.ts', 'src/commands/skill.ts', 'src/commands/statusline.ts',
  'src/commands/update.ts', 'src/commands/wiki.ts', 'src/install.ts', 'src/scheduler.ts',
]);
const ALLOWED_NETWORK = new Set([
  'src/apibrain.ts', 'src/commands/doctor.ts', 'src/commands/update.ts', 'src/localmodel.ts',
  'src/memory.ts', 'src/registry.ts', 'src/telegram.ts',
]);
for (const f of walk(join(ROOT, 'src')).filter((p) => /\.[cm]?[jt]sx?$/.test(p))) {
  const r = rel(f);
  const src = readFileSync(f, 'utf8');
  if (/node:child_process|from 'child_process'/.test(src) && !ALLOWED_SPAWN.has(r)) errors.push(`${r}: imports child_process but is not in ALLOWED_SPAWN`);
  if (/\bfetch\(|node:https?|node:net|node:dgram|WebSocket\(/.test(src) && !ALLOWED_NETWORK.has(r)) errors.push(`${r}: uses the network but is not in ALLOWED_NETWORK`);
}

// 7. workflows ---------------------------------------------------------------
const ALLOWED_SECRETS = { 'release.yml': new Set(['NPM_TOKEN', 'HOMEBREW_TAP_TOKEN', 'GITHUB_TOKEN']) };
const wfDir = join(ROOT, '.github/workflows');
if (existsSync(wfDir)) {
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(wfDir, f), 'utf8');
    if (/pull_request_target/.test(text)) errors.push(`.github/workflows/${f}: pull_request_target runs fork code with secrets`);
    for (const m of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
      if (!(ALLOWED_SECRETS[f] ?? new Set()).has(m[1])) errors.push(`.github/workflows/${f}: secret "${m[1]}" not in ALLOWED_SECRETS`);
    }
  }
}

finish('security-guards', errors);
