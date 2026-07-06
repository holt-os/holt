/**
 * Skill registry: a discovery + sharing layer for SKILL.md skills. Zero-infra
 * and git-based. A "registry" is just a JSON document living in a git repo:
 *
 *   { "version": 1, "skills": [ { name, description, source, author, tags? } ] }
 *
 * `source` is anything `holt skill add` already accepts: a git URL (optionally
 * pointing at a repo whose SKILL.md is in one subfolder) or a local path. So
 * install-by-name is just "resolve the name to its source, then run the normal
 * add path".
 *
 * The default index is the community registry on GitHub (raw JSON), overridable
 * with HOLT_REGISTRY_URL so the whole thing is testable against a local file,
 * a file:// URL, or a plain path with no server or network at all. Nothing here
 * hard-fails: an unreachable or 404 registry degrades to a clear message, and a
 * bad cache is ignored rather than thrown.
 *
 * No dependencies: fetch (or a local read) with a timeout, tolerant JSON parse.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { GLOBAL_DIR } from './workspace';

/** Community registry index. This repo is not live yet; see README for the plan. */
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/holt-os/registry/main/registry.json';

/** The repo a `publish` PR should target (human-facing, not fetched). */
export const REGISTRY_REPO_URL = 'https://github.com/holt-os/registry';

/** Cache TTL in milliseconds (one hour). */
export const CACHE_TTL_MS = 60 * 60 * 1000;

export interface RegistrySkill {
  name: string;
  description: string;
  /**
   * A git URL or local path, exactly what `holt skill add <source>` accepts.
   * May include a `#<subpath>` suffix (e.g. `.../registry#skills/pm-prd`) to
   * point at one skill folder inside a monorepo; installFromSource handles it.
   */
  source: string;
  author: string;
  tags?: string[];
}

export interface Registry {
  version: number;
  skills: RegistrySkill[];
}

/** Where the fetched index is cached between runs. */
export function registryCachePath(): string {
  return join(GLOBAL_DIR, 'registry-cache.json');
}

/** The configured registry location: env override, else the community default. */
export function registryUrl(): string {
  const env = (process.env.HOLT_REGISTRY_URL || '').trim();
  return env || DEFAULT_REGISTRY_URL;
}

/**
 * Coerce an unknown parsed value into a Registry, dropping malformed entries.
 * Tolerant on purpose: a registry with one bad row still yields the good ones.
 */
export function coerceRegistry(value: unknown): Registry | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as { version?: unknown; skills?: unknown };
  const skillsRaw = Array.isArray(obj.skills) ? obj.skills : [];
  const skills: RegistrySkill[] = [];
  for (const row of skillsRaw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const source = typeof r.source === 'string' ? r.source.trim() : '';
    if (!name || !source) continue; // name + source are the minimum to be useful
    const description = typeof r.description === 'string' ? r.description.trim() : '';
    const author = typeof r.author === 'string' ? r.author.trim() : '';
    const tags = Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
      : undefined;
    const entry: RegistrySkill = { name, description, source, author };
    if (tags && tags.length) entry.tags = tags;
    skills.push(entry);
  }
  const version = typeof obj.version === 'number' ? obj.version : 1;
  return { version, skills };
}

/** Parse JSON tolerantly into a Registry, or null on any failure. */
function parseRegistry(text: string): Registry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return coerceRegistry(parsed);
}

interface CacheFile {
  fetchedAt: number;
  url: string;
  registry: Registry;
}

/** Read the on-disk cache. Never throws; returns null on any problem. */
function readCache(): CacheFile | null {
  try {
    const path = registryCachePath();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheFile>;
    if (!raw || typeof raw.fetchedAt !== 'number' || typeof raw.url !== 'string') return null;
    const registry = coerceRegistry(raw.registry);
    if (!registry) return null;
    return { fetchedAt: raw.fetchedAt, url: raw.url, registry };
  } catch {
    return null;
  }
}

/** Write the cache. Best-effort; a failure here never breaks a fetch. */
function writeCache(url: string, registry: Registry): void {
  try {
    mkdirSync(GLOBAL_DIR, { recursive: true });
    const body: CacheFile = { fetchedAt: Date.now(), url, registry };
    writeFileSync(registryCachePath(), JSON.stringify(body, null, 2) + '\n', 'utf8');
  } catch {
    // best effort; a stale/missing cache just means a re-fetch next time
  }
}

/**
 * Is `loc` a local file location (a plain path or a file:// URL) rather than an
 * http(s) URL we must fetch over the network? Local sources make the registry
 * fully testable with no server.
 */
function localPathFor(loc: string): string | null {
  if (loc.startsWith('file://')) {
    try {
      return fileURLToPath(loc);
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(loc)) return null;
  // Anything else is treated as a filesystem path.
  return isAbsolute(loc) ? loc : resolve(loc);
}

export interface FetchResult {
  registry: Registry | null;
  /** True when the value came from the on-disk cache rather than a live read. */
  fromCache: boolean;
  /** A human-readable reason when registry is null (unreachable / not-live). */
  error?: string;
}

const UNREACHABLE_MSG =
  'no registry reachable; set HOLT_REGISTRY_URL or the community registry is not live yet';

/** Read a local registry file (path or file:// URL). Never throws. */
function loadLocal(path: string): FetchResult {
  try {
    if (!existsSync(path)) {
      return { registry: null, fromCache: false, error: UNREACHABLE_MSG };
    }
    const registry = parseRegistry(readFileSync(path, 'utf8'));
    if (!registry) {
      return { registry: null, fromCache: false, error: 'registry file is not valid JSON' };
    }
    return { registry, fromCache: false };
  } catch {
    return { registry: null, fromCache: false, error: UNREACHABLE_MSG };
  }
}

/** Fetch a remote registry over http(s) with a timeout. Never throws. */
async function loadRemote(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      // 404 etc: the community index likely is not live yet.
      return { registry: null, fromCache: false, error: UNREACHABLE_MSG };
    }
    const registry = parseRegistry(await res.text());
    if (!registry) {
      return { registry: null, fromCache: false, error: 'registry response is not valid JSON' };
    }
    return { registry, fromCache: false };
  } catch {
    // Network error, DNS failure, timeout, dead host: all degrade gracefully.
    return { registry: null, fromCache: false, error: UNREACHABLE_MSG };
  }
}

/**
 * Load the registry index. Uses a fresh cache (< TTL, same URL) unless
 * `refresh` is set, otherwise reads the source (local file or remote URL) and
 * refreshes the cache on success. On a failed live read, falls back to any
 * cached copy (even stale) so search/add still work offline. Never throws.
 */
export async function loadRegistry(opts: { refresh?: boolean } = {}): Promise<FetchResult> {
  const url = registryUrl();
  const cached = readCache();
  const fresh = cached && cached.url === url && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

  if (!opts.refresh && fresh && cached) {
    return { registry: cached.registry, fromCache: true };
  }

  const local = localPathFor(url);
  const result = local ? loadLocal(local) : await loadRemote(url);

  if (result.registry) {
    writeCache(url, result.registry);
    return result;
  }

  // Live read failed: fall back only to a cache for THIS url (even if stale),
  // so switching HOLT_REGISTRY_URL to a dead host never silently serves another
  // registry's cached rows.
  if (cached && cached.url === url) {
    return { registry: cached.registry, fromCache: true, error: result.error };
  }
  return result;
}

/**
 * Filter + rank skills for a query (case-insensitive substring over name,
 * description, and tags). Name matches rank first, then description, then tags.
 * An empty query returns every skill, name-sorted. Pure, no I/O.
 */
export function searchSkills(skills: RegistrySkill[], query: string): RegistrySkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const rank = (s: RegistrySkill): number => {
    if (s.name.toLowerCase().includes(q)) return 0;
    if (s.description.toLowerCase().includes(q)) return 1;
    if ((s.tags || []).some((t) => t.toLowerCase().includes(q))) return 2;
    return 3;
  };
  return skills
    .map((s) => ({ s, r: rank(s) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.s.name.localeCompare(b.s.name)))
    .map((x) => x.s);
}

/** Find a registry entry by exact (case-insensitive) name. */
export function resolveByName(skills: RegistrySkill[], name: string): RegistrySkill | null {
  const want = name.trim().toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === want) || null;
}

/**
 * Build the JSON registry entry a `publish` should print, from a skill's
 * name/description and a chosen source + author. Returned pretty-printed and
 * indented so it drops straight into the registry `skills` array in a PR.
 */
export function buildPublishEntry(input: {
  name: string;
  description: string;
  source: string;
  author: string;
  tags?: string[];
}): string {
  const entry: RegistrySkill = {
    name: input.name,
    description: input.description,
    source: input.source,
    author: input.author,
  };
  if (input.tags && input.tags.length) entry.tags = input.tags;
  // Indent by two spaces so it reads as one element of the skills array.
  return JSON.stringify(entry, null, 2)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n');
}

/** True for a location Holt treats as local (used to hint the fallback message). */
export function isLocalRegistry(loc: string = registryUrl()): boolean {
  return localPathFor(loc) !== null;
}

// pathToFileURL is exported for tests that want to build a file:// override.
export { pathToFileURL };

/** Freshness helper for callers/tests: seconds since the cache was written, or null. */
export function cacheAgeMs(): number | null {
  try {
    const p = registryCachePath();
    if (!existsSync(p)) return null;
    return Date.now() - statSync(p).mtimeMs;
  } catch {
    return null;
  }
}
