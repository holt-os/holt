/**
 * Cross-brain skill compiler. Turns every ENABLED Holt skill into the active
 * brain's own native custom-command format, so a Holt skill shows up as a real
 * slash command inside the launched interactive session.
 *
 * This mirrors launch.ts's "canonical thing, per-brain adapter, non-destructive,
 * track-what-we-wrote" pattern (see brandContextFile / brandStatusLine): there is
 * ONE canonical artifact (the SKILL.md) and a small adapter per brain that emits
 * that brain's native form. Everything Holt writes is recorded in a per-folder
 * manifest so removal is surgical, and nothing the user authored is ever touched.
 *
 * Fidelity per brain (design locked with the product owner):
 *   - claude: FULL power. The skill folder is copied VERBATIM into the project
 *     .claude/skills/<name>/ (multi-file, tool restrictions, frontmatter all
 *     preserved). Holt skills are already agentskills.io format, so this is 1:1.
 *   - gemini: BEST-EFFORT. A project .gemini/commands/<name>.toml is generated
 *     from {description, prompt}. Prompt-only fidelity.
 *   - codex: BEST-EFFORT. A markdown custom-prompt file is generated from the
 *     same fields. Prompt-only fidelity.
 *
 * Empirically verified formats (checked against official docs, July 2026):
 *   - Gemini custom commands: project dir <ws>/.gemini/commands/, TOML files,
 *     required field `prompt`, optional `description`, args via `{{args}}`.
 *     (github.com/google-gemini/gemini-cli docs/cli/custom-commands.md)
 *   - Codex custom prompts: GLOBAL ONLY at ~/.codex/prompts/ (NOT project-level,
 *     NOT shared per-repo), markdown `.md`, YAML frontmatter `description` +
 *     `argument-hint`, args via `$ARGUMENTS` / `$1..$9`. Because Codex prompts
 *     are global, a per-folder manifest is essential to avoid one folder's
 *     compiled prompts clobbering another's. (developers.openai.com/codex custom
 *     prompts, redirected to learn.chatgpt.com/docs/custom-prompts.)
 *
 * Graceful degradation: any skill that cannot be expressed for a target is
 * SKIPPED with a one-line note; this module never throws out of launch/setup.
 * Zero runtime dependencies. No em-dash characters (CI enforces this).
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { BrainId } from './config';
import { wsHoltDir, workspace } from './workspace';
import { listSkills, parseFrontmatter, type Skill } from './skills';
import { c } from './ui';

// ---------------------------------------------------------------------------
// Markers + manifest
// ---------------------------------------------------------------------------

/**
 * A generated Gemini/Codex file carries this marker so we can recognize our own
 * output even if the manifest is lost. Claude skills are copied verbatim (we
 * cannot inject a marker into an arbitrary multi-file skill without corrupting
 * it), so for Claude "ours" is decided by the manifest alone.
 */
const MARKER = 'holt-managed skill';

/** Prefix for compiled Codex prompt files. Codex prompts are GLOBAL, so this
 * namespace keeps Holt's compiled prompts from colliding with a user's own and
 * makes them easy to spot in ~/.codex/prompts. */
const CODEX_PREFIX = 'holt-';

/** Manifest file, per folder, listing every artifact Holt compiled here. */
function manifestPath(ws: string = workspace()): string {
  return join(wsHoltDir(ws), 'skill-commands.json');
}

/** One compiled artifact Holt wrote for a skill under a brain. */
interface ManifestEntry {
  /** Skill name this artifact was compiled from. */
  skill: string;
  /** Absolute path of the file or folder Holt wrote. */
  path: string;
  /** sha256 of what Holt last wrote, so we can detect user edits and know when
   * a rewrite is actually needed (keeps repeat launches quiet). For a Claude
   * skill folder this hashes the folder's file list + contents. */
  hash: string;
}

interface Manifest {
  version: number;
  /** Per-brain list of artifacts Holt wrote. */
  brains: Partial<Record<BrainId, ManifestEntry[]>>;
}

function emptyManifest(): Manifest {
  return { version: 1, brains: {} };
}

function readManifest(ws: string = workspace()): Manifest {
  const p = manifestPath(ws);
  if (!existsSync(p)) return emptyManifest();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<Manifest>;
    const brains = (parsed.brains && typeof parsed.brains === 'object' ? parsed.brains : {}) as Partial<
      Record<BrainId, ManifestEntry[]>
    >;
    return { version: 1, brains };
  } catch {
    return emptyManifest();
  }
}

function writeManifest(m: Manifest, ws: string = workspace()): void {
  mkdirSync(wsHoltDir(ws), { recursive: true });
  writeFileSync(manifestPath(ws), JSON.stringify(m, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function hashString(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Stable hash of a directory's contents (sorted relative paths + file bytes), so
 * a copied Claude skill can be compared without re-copying when nothing changed.
 * Best-effort: unreadable entries are skipped rather than throwing.
 */
function hashDir(dir: string): string {
  const h = createHash('sha256');
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    let entries: string[];
    try {
      entries = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const childRel = rel ? join(rel, name) : name;
      const childAbs = join(dir, childRel);
      let st;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        h.update('D:' + childRel + '\n');
        walk(childRel);
      } else {
        h.update('F:' + childRel + '\n');
        try {
          h.update(readFileSync(childAbs));
        } catch {
          /* skip unreadable file */
        }
      }
    }
  };
  walk('');
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Adapters: canonical skill -> per-brain artifact
// ---------------------------------------------------------------------------

/** The canonical facts a best-effort adapter needs, read from the SKILL.md. */
interface SkillSource {
  name: string;
  description: string;
  /** The full Markdown body (frontmatter stripped): the skill's instructions. */
  body: string;
}

function readSkillSource(skill: Skill): SkillSource | null {
  const file = join(skill.dir, 'SKILL.md');
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const description = (data.description || skill.description || '').trim();
  return { name: skill.name, description, body: body.trim() };
}

/** Minimal TOML string escaper for a double-quoted value (used for description). */
function tomlBasicString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .trim();
}

/**
 * A TOML multi-line basic string ("""...""") for the prompt. TOML forbids an
 * unescaped run that would close the delimiter, and a trailing backslash escapes
 * a newline, so we defend both: escape backslashes, then any occurrence of the
 * closing delimiter.
 */
function tomlMultiline(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
}

/** Build the Gemini `.gemini/commands/<name>.toml` content, or null if we cannot
 * express this skill (no body and no description = nothing to prompt with). */
function renderGeminiToml(src: SkillSource): string | null {
  const instructions = src.body || src.description;
  if (!instructions.trim()) return null;
  // The prompt is the skill's instructions, then the user's input via {{args}}.
  // Gemini appends args automatically when {{args}} is absent, but we place it
  // explicitly so the instructions clearly frame the user's request.
  const prompt = [
    instructions,
    '',
    'Apply the skill above to this request:',
    '{{args}}',
  ].join('\n');
  const lines = [
    `# ${MARKER}: ${src.name}`,
    '# Generated by Holt from a SKILL.md. Edit the skill, not this file: Holt',
    '# will overwrite it on the next launch. Delete via "holt skill remove".',
  ];
  if (src.description) lines.push(`description = "${tomlBasicString(src.description)}"`);
  lines.push('prompt = """');
  lines.push(tomlMultiline(prompt));
  lines.push('"""');
  return lines.join('\n') + '\n';
}

/** Build the Codex `~/.codex/prompts/holt-<name>.md` content, or null if empty. */
function renderCodexPrompt(src: SkillSource): string | null {
  const instructions = src.body || src.description;
  if (!instructions.trim()) return null;
  const front = ['---'];
  if (src.description) front.push(`description: ${src.description.replace(/\n/g, ' ').trim()}`);
  front.push('argument-hint: [request]');
  front.push('---');
  const parts = [
    front.join('\n'),
    '',
    `<!-- ${MARKER}: ${src.name} (generated by Holt from a SKILL.md; do not edit) -->`,
    '',
    instructions,
    '',
    'Apply the skill above to this request:',
    '',
    '$ARGUMENTS',
    '',
  ];
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Target-location helpers
// ---------------------------------------------------------------------------

/** Claude: the project skills dir that Claude Code reads on startup. */
function claudeSkillsDir(ws: string): string {
  return join(ws, '.claude', 'skills');
}
/** Gemini: the project commands dir. */
function geminiCommandsDir(ws: string): string {
  return join(ws, '.gemini', 'commands');
}
/** Codex: the GLOBAL prompts dir (Codex has no project-level prompts). */
function codexPromptsDir(): string {
  return join(homedir(), '.codex', 'prompts');
}

/** Is this file one Holt wrote (marker present)? Used as a fallback to the
 * manifest so we never clobber a user's own command that happens to share a
 * name. */
function fileIsOurs(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Compile / clean, per brain
// ---------------------------------------------------------------------------

export interface CompileResult {
  /** Artifacts written or refreshed this run. */
  written: string[];
  /** Targets skipped because a non-Holt file already occupies them. */
  skippedExisting: string[];
  /** Skills that could not be expressed for this brain. */
  skippedUnexpressible: string[];
  /** Stale Holt artifacts removed (skill no longer enabled). */
  removed: string[];
}

function emptyResult(): CompileResult {
  return { written: [], skippedExisting: [], skippedUnexpressible: [], removed: [] };
}

/** Look up a prior manifest entry for a (brain, path). */
function priorEntry(m: Manifest, brain: BrainId, path: string): ManifestEntry | undefined {
  return (m.brains[brain] || []).find((e) => e.path === path);
}

/**
 * Compile all ENABLED skills into `brain`'s native format for `ws`. Idempotent
 * and quiet: a target whose content already matches what Holt last wrote is left
 * untouched and not reported as written. Stale Holt artifacts (for skills that
 * are no longer enabled) are removed. Never throws.
 */
export function compileForBrain(brain: BrainId, ws: string = workspace()): CompileResult {
  const res = emptyResult();
  const manifest = readManifest(ws);
  const prior = manifest.brains[brain] || [];
  const nextEntries: ManifestEntry[] = [];

  let skills: Skill[];
  try {
    skills = listSkills();
  } catch {
    return res;
  }
  const enabledNames = new Set(skills.map((s) => s.name));

  for (const skill of skills) {
    try {
      if (brain === 'claude') {
        compileClaude(skill, ws, manifest, res, nextEntries);
      } else if (brain === 'gemini') {
        compileGemini(skill, ws, manifest, res, nextEntries);
      } else {
        compileCodex(skill, manifest, res, nextEntries);
      }
    } catch {
      // One skill failing must never abort the whole compile or the launch.
      res.skippedUnexpressible.push(skill.name);
    }
  }

  // Remove stale Holt artifacts: previously compiled for a skill that is no
  // longer enabled (or was renamed). Only ever remove what the manifest says is
  // ours; never touch a path we did not write.
  for (const e of prior) {
    if (enabledNames.has(e.skill) && nextEntries.some((n) => n.path === e.path)) continue;
    if (removeArtifact(e.path)) res.removed.push(e.path);
  }

  manifest.brains[brain] = nextEntries;
  try {
    writeManifest(manifest, ws);
  } catch {
    /* manifest is best-effort; compiled files still work */
  }
  return res;
}

/** Claude adapter: copy the whole skill folder verbatim into project skills. */
function compileClaude(
  skill: Skill,
  ws: string,
  manifest: Manifest,
  res: CompileResult,
  next: ManifestEntry[],
): void {
  const dest = join(claudeSkillsDir(ws), skill.name);
  const known = priorEntry(manifest, 'claude', dest);

  if (existsSync(dest) && !known) {
    // A skill folder we did not write already lives here: never clobber it.
    res.skippedExisting.push(dest);
    return;
  }

  const srcHash = hashDir(skill.dir);
  if (known && known.hash === srcHash && existsSync(dest)) {
    // Already in sync with what Holt last wrote: keep quiet, retain the entry.
    next.push(known);
    return;
  }

  // (Re)write: clear our previous copy, then copy the source folder verbatim so
  // multi-file skills, tool restrictions and frontmatter are preserved 1:1.
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(skill.dir, dest, { recursive: true });
  next.push({ skill: skill.name, path: dest, hash: hashDir(dest) });
  res.written.push(dest);
}

/** Gemini adapter: emit a project-level TOML custom command. */
function compileGemini(
  skill: Skill,
  ws: string,
  manifest: Manifest,
  res: CompileResult,
  next: ManifestEntry[],
): void {
  const src = readSkillSource(skill);
  if (!src) {
    res.skippedUnexpressible.push(skill.name);
    return;
  }
  const content = renderGeminiToml(src);
  if (content === null) {
    res.skippedUnexpressible.push(skill.name);
    return;
  }
  const dest = join(geminiCommandsDir(ws), `${skill.name}.toml`);
  writeTextArtifact('gemini', skill.name, dest, content, manifest, res, next);
}

/** Codex adapter: emit a GLOBAL markdown custom prompt (namespaced holt-<name>). */
function compileCodex(
  skill: Skill,
  manifest: Manifest,
  res: CompileResult,
  next: ManifestEntry[],
): void {
  const src = readSkillSource(skill);
  if (!src) {
    res.skippedUnexpressible.push(skill.name);
    return;
  }
  const content = renderCodexPrompt(src);
  if (content === null) {
    res.skippedUnexpressible.push(skill.name);
    return;
  }
  const dest = join(codexPromptsDir(), `${CODEX_PREFIX}${skill.name}.md`);
  writeTextArtifact('codex', skill.name, dest, content, manifest, res, next);
}

/**
 * Shared write path for the two text-file adapters (Gemini/Codex): non-clobber,
 * idempotent, manifest-tracked. Writes only when a target is ours (manifest or
 * marker) or absent, and only when content actually changed.
 */
function writeTextArtifact(
  brain: BrainId,
  skillName: string,
  dest: string,
  content: string,
  manifest: Manifest,
  res: CompileResult,
  next: ManifestEntry[],
): void {
  const known = priorEntry(manifest, brain, dest);
  if (existsSync(dest) && !known && !fileIsOurs(dest)) {
    // A user's own command with this name already exists: never overwrite it.
    res.skippedExisting.push(dest);
    return;
  }
  const hash = hashString(content);
  if (existsSync(dest)) {
    let cur = '';
    try {
      cur = readFileSync(dest, 'utf8');
    } catch {
      cur = '';
    }
    if (hashString(cur) === hash) {
      // Byte-identical to what we would write: stay quiet.
      next.push({ skill: skillName, path: dest, hash });
      return;
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, 'utf8');
  next.push({ skill: skillName, path: dest, hash });
  res.written.push(dest);
}

/** Remove a single Holt artifact (file or folder). Returns true if it removed
 * something. Never throws. */
function removeArtifact(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Sync compiled skill commands for the ONE brain being launched, printing a
 * quiet one-line summary only when something actually changed (mirrors how the
 * hook install stays silent on repeat launches). Never throws out of launch.
 */
export function syncSkillCommands(brain: BrainId, ws: string = workspace()): void {
  let res: CompileResult;
  try {
    res = compileForBrain(brain, ws);
  } catch {
    return; // compilation is best-effort; a failure must not block launch
  }
  reportQuiet(brain, res);
}

/**
 * Compile for EVERY brain that could be launched (used on `holt skill add` /
 * `holt skill remove`, where we do not yet know which brain the user will
 * launch). Enabled brains from config; if config is missing, all three.
 */
export function syncAllBrains(enabled: BrainId[], ws: string = workspace()): void {
  for (const brain of enabled) {
    try {
      const res = compileForBrain(brain, ws);
      reportQuiet(brain, res);
    } catch {
      /* per-brain best effort */
    }
  }
}

/**
 * Remove every Holt-compiled artifact for a single skill across ALL brains, then
 * update each brain's manifest. Used by `holt skill remove <name>` so a removed
 * skill leaves no orphan commands. Only removes paths the manifest records as
 * ours. Returns the count removed.
 */
export function removeSkillArtifacts(skillName: string, ws: string = workspace()): number {
  const manifest = readManifest(ws);
  let removed = 0;
  for (const brain of Object.keys(manifest.brains) as BrainId[]) {
    const entries = manifest.brains[brain] || [];
    const keep: ManifestEntry[] = [];
    for (const e of entries) {
      if (e.skill === skillName) {
        if (removeArtifact(e.path)) removed++;
      } else {
        keep.push(e);
      }
    }
    manifest.brains[brain] = keep;
  }
  try {
    writeManifest(manifest, ws);
  } catch {
    /* best effort */
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Quiet reporting
// ---------------------------------------------------------------------------

const BRAIN_LABEL: Record<BrainId, string> = {
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  codex: 'Codex',
};

/**
 * Print at most a couple of dim lines, and ONLY when something changed or a
 * clobber was avoided. A steady-state launch (nothing changed) prints nothing,
 * so repeat launches stay silent (mirrors how the hook install stays quiet).
 */
function reportQuiet(brain: BrainId, res: CompileResult): void {
  const changed = res.written.length + res.removed.length;
  if (changed === 0 && res.skippedExisting.length === 0) return;
  const label = BRAIN_LABEL[brain];
  const parts: string[] = [];
  if (res.written.length) parts.push(`${res.written.length} synced`);
  if (res.removed.length) parts.push(`${res.removed.length} removed`);
  if (parts.length) {
    console.log(c.dim(`  Skills as ${label} commands: ${parts.join(', ')}.`));
  }
  for (const p of res.skippedExisting) {
    console.log(c.dim(`  Skipped ${p} (already exists and not written by Holt).`));
  }
}
