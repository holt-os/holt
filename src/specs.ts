/**
 * Machine detection and recommendation logic for Holt.
 *
 * Pure and dependency-free: reads the host with node:os and process.version,
 * and maps RAM to a suggested local model. Kept canonical here so `holt doctor`
 * and any other part of Holt (the knowledge wiki maintainer, init prompts) can
 * share one source of truth instead of duplicating tier tables.
 */
import os from 'node:os';

export interface MachineSpecs {
  platform: string; // os.platform(), e.g. "darwin", "linux", "win32"
  arch: string; // os.arch(), e.g. "arm64", "x64"
  cpuModel: string; // first CPU model string, or "unknown"
  cpuCount: number; // logical cores
  totalRamGB: number; // rounded to whole GB
  freeRamGB: number; // rounded to whole GB
  nodeVersion: string; // process.version, e.g. "v20.14.0"
}

const BYTES_PER_GB = 1024 ** 3;

function toGB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / BYTES_PER_GB);
}

/**
 * Detect the current machine. Never throws: any field that cannot be read
 * degrades to a safe default ("unknown" / 0) so callers can render a partial
 * report rather than crashing.
 */
export function detect(): MachineSpecs {
  let platform = 'unknown';
  let arch = 'unknown';
  let cpuModel = 'unknown';
  let cpuCount = 0;
  let totalRamGB = 0;
  let freeRamGB = 0;
  let nodeVersion = 'unknown';

  try {
    platform = os.platform();
  } catch {
    /* keep default */
  }
  try {
    arch = os.arch();
  } catch {
    /* keep default */
  }
  try {
    const cpus = os.cpus();
    if (Array.isArray(cpus) && cpus.length) {
      cpuCount = cpus.length;
      const first = cpus[0];
      if (first && typeof first.model === 'string' && first.model.trim()) {
        cpuModel = first.model.trim();
      }
    }
  } catch {
    /* keep defaults */
  }
  try {
    totalRamGB = toGB(os.totalmem());
  } catch {
    /* keep default */
  }
  try {
    freeRamGB = toGB(os.freemem());
  } catch {
    /* keep default */
  }
  try {
    if (typeof process.version === 'string' && process.version) nodeVersion = process.version;
  } catch {
    /* keep default */
  }

  return { platform, arch, cpuModel, cpuCount, totalRamGB, freeRamGB, nodeVersion };
}

/** A local-model recommendation for one RAM tier. */
export interface LocalModelRec {
  /** True when a local generative model is a reasonable idea at this tier. */
  local: boolean;
  /** Primary Ollama model tag to pull, e.g. "qwen2.5:7b". Null when discouraged. */
  model: string | null;
  /** Optional second choice at the same tier. */
  alt?: string;
  /** Rough on-disk / memory footprint, human-readable. */
  size?: string;
  /** One-line plain-language guidance for this tier. */
  note: string;
}

/**
 * RAM-tiered local model guidance. Single editable table: the wiki maintainer
 * note and the doctor report both read this, so tuning models happens here only.
 * Tiers are checked from the largest floor down in recommendLocalModel().
 */
export const LOCAL_MODEL_RECS: Array<{ minRamGB: number; rec: LocalModelRec }> = [
  {
    minRamGB: 48,
    rec: {
      local: true,
      model: 'qwen2.5:32b',
      size: '~20GB',
      note: 'Plenty of headroom. A 32B model runs comfortably and gives the best local quality.',
    },
  },
  {
    minRamGB: 24,
    rec: {
      local: true,
      model: 'qwen2.5:14b',
      size: '~9GB',
      note: 'A 14B model fits well here and is a solid local maintainer.',
    },
  },
  {
    minRamGB: 16,
    rec: {
      local: true,
      model: 'qwen2.5:7b',
      alt: 'llama3.1:8b',
      size: '~4.7GB',
      note: 'A 7B model works but is tight alongside the embed model and your editor. Prefer running it on your always-on machine.',
    },
  },
  {
    minRamGB: 0,
    rec: {
      // Discouraged below 16GB: local generation is too modest to be worth it
      // for the wiki maintainer. The small model stays named as the only viable
      // option if you insist, but local is off by default here.
      local: false,
      model: 'llama3.2:3b',
      size: '~2GB',
      note: 'Under 16GB, local generation is modest. A small 3B model is the safe ceiling; the hosted "brain" maintainer will be noticeably better, so it is the recommendation here.',
    },
  },
];

/**
 * Recommend a local generative model for a machine with totalRamGB of RAM.
 * Returns the matching tier's recommendation. Below 16GB, local is discouraged
 * (still returns the small-model fallback but flags it in the note).
 */
export function recommendLocalModel(totalRamGB: number): LocalModelRec {
  const ram = Number.isFinite(totalRamGB) && totalRamGB > 0 ? totalRamGB : 0;
  for (const tier of LOCAL_MODEL_RECS) {
    if (ram >= tier.minRamGB) return tier.rec;
  }
  // LOCAL_MODEL_RECS always has a minRamGB:0 tier, so this is unreachable in
  // practice; kept as a defensive default so the function is total.
  return {
    local: false,
    model: null,
    note: 'Could not read RAM. Use the hosted "brain" maintainer to be safe.',
  };
}
