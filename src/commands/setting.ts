import {
  loadConfig,
  saveConfig,
  defaultConfig,
  BRAIN_IDS,
  PROVIDERS,
  PROVIDER_MODEL_SUGGESTION,
  isReservedBrainId,
  findApiBrain,
  resolveApiKey,
  saveCredential,
  type HoltConfig,
  type BrainId,
  type Provider,
  type ApiBrain,
} from '../config';
import { isInstalled } from '../brains';
import { installAlias, removeAlias, currentAlias } from '../alias';
import { ensureTrusted } from '../workspace';
import { c, createReader, type Ask } from '../ui';

function printStatus(cfg: HoltConfig): void {
  console.log('\n' + c.accent('Holt settings') + c.dim('  (this folder)'));
  for (const id of BRAIN_IDS) {
    const b = cfg.brains[id];
    const tags = [
      b.enabled ? c.green('enabled') : (isInstalled(b.command) ? c.dim('installed, off') : c.dim('not installed')),
      cfg.defaultBrain === id ? c.accent('default') : '',
    ].filter(Boolean).join('  ');
    console.log(`  ${id.padEnd(10)} ${b.label.padEnd(16)} ${tags}`);
  }
  if (cfg.apiBrains.length) {
    console.log(c.dim('  api brains:'));
    for (const a of cfg.apiBrains) {
      const key = resolveApiKey(a) ? c.green('key ok') : c.red('no key');
      const def = cfg.defaultBrain === a.id ? c.accent('default') : '';
      console.log(`  ${a.id.padEnd(10)} ${`${a.provider}/${a.model}`.padEnd(30)} ${key}  ${def}`);
    }
  }
  console.log(c.dim(`  output format: ${cfg.outputFormat}`));
  console.log(c.dim(`  launch command: ${currentAlias() || 'holt (default)'}`));
  console.log('\n  ' + c.dim('[d] default brain   [t] toggle brain   [c] connect API brain   [x] remove API brain   [a] launch command   [enter] done'));
}

/**
 * Shared connect-an-API-brain flow. Prompts for provider, model, id, and key
 * (paste stored 0o600, or an env var name). Mutates and returns cfg. Reused by
 * init so both entry points behave identically. Returns null if cancelled.
 */
export async function connectApiBrain(ask: Ask, cfg: HoltConfig): Promise<ApiBrain | null> {
  // Re-ask on bad input instead of silently cancelling; enter picks the first
  // provider, "skip" backs out on purpose.
  let provider: Provider | null = null;
  for (let tries = 0; tries < 3 && !provider; tries++) {
    const provRaw = ((await ask(`  provider [${PROVIDERS.join('/')}] (enter for ${PROVIDERS[0]}, or "skip"): `)) ?? 'skip')
      .trim()
      .toLowerCase();
    if (provRaw === 'skip' || provRaw === 'q' || provRaw === 'n' || provRaw === 'no') {
      console.log(c.dim('  skipped. Add one later with "holt setting" then "c".'));
      return null;
    }
    if (provRaw === '') provider = PROVIDERS[0] as Provider;
    else if ((PROVIDERS as string[]).includes(provRaw)) provider = provRaw as Provider;
    else console.log(c.dim(`  "${provRaw}" is not a provider. Type one of: ${PROVIDERS.join(', ')}`));
  }
  if (!provider) {
    console.log(c.dim('  skipped after three tries. Add one later with "holt setting" then "c".'));
    return null;
  }

  const suggestion = PROVIDER_MODEL_SUGGESTION[provider];
  const modelRaw = ((await ask(`  model (enter for ${suggestion}): `)) ?? '').trim();
  const model = modelRaw || suggestion;

  const idRaw = ((await ask('  short name for this brain (e.g. sonnet): ')) ?? '').trim();
  if (!idRaw) {
    console.log(c.dim('  cancelled (no name).'));
    return null;
  }
  if (isReservedBrainId(idRaw)) {
    console.log(c.red(`  "${idRaw}" is reserved for a CLI brain. Pick another name.`));
    return null;
  }
  if (findApiBrain(cfg, idRaw)) {
    console.log(c.red(`  an API brain named "${idRaw}" already exists.`));
    return null;
  }

  console.log(c.dim('  key: paste a raw key (stored locally, mode 600), or type the name of an env var that holds it.'));
  const keyRaw = ((await ask('  key or env var name: ')) ?? '').trim();
  let keyEnv: string | undefined;
  if (!keyRaw) {
    console.log(c.dim('  no key given now. You can set the standard env var later.'));
  } else if (/^[A-Z][A-Z0-9_]*$/.test(keyRaw)) {
    // Looks like an env var name.
    keyEnv = keyRaw;
    console.log(c.dim(`  will read the key from env var ${keyEnv}.`));
  } else {
    saveCredential(provider, keyRaw);
    console.log(c.green(`  key stored in ~/.holt/credentials.json (mode 600).`));
  }

  const brain: ApiBrain = { id: idRaw, provider, model, ...(keyEnv ? { keyEnv } : {}) };
  cfg.apiBrains.push(brain);
  const resolvable = resolveApiKey(brain);
  console.log(c.green(`  connected "${idRaw}" -> ${provider}/${model}.`) + (resolvable ? '' : c.dim(' (no key resolves yet)')));
  return brain;
}

/** All selectable brain ids: enabled CLI brains plus every API brain. */
function selectableIds(cfg: HoltConfig): string[] {
  return [...BRAIN_IDS.filter((id) => cfg.brains[id].enabled), ...cfg.apiBrains.map((a) => a.id)];
}

/** Interactive settings loop. Reuses a caller-provided prompt so it can run inside chat. */
export async function runSettings(ask: Ask): Promise<HoltConfig> {
  let cfg = loadConfig() ?? defaultConfig();
  while (true) {
    printStatus(cfg);
    const raw = await ask('  > ');
    const choice = (raw ?? '').trim().toLowerCase();
    if (raw === null || choice === '' || choice === 'q') break;

    if (choice === 'd') {
      const options = selectableIds(cfg);
      if (options.length === 0) { console.log(c.dim('  No brains ready. Toggle a CLI brain on ("t") or connect an API brain ("c").')); continue; }
      const pick = ((await ask(`  default brain [${options.join('/')}]: `)) ?? '').trim();
      if (options.includes(pick)) {
        cfg.defaultBrain = pick;
        const label = (BRAIN_IDS as string[]).includes(pick) ? cfg.brains[pick as BrainId].label : pick;
        console.log(c.green(`  default set to ${label}`));
      } else console.log(c.dim('  unchanged.'));
    } else if (choice === 't') {
      const pick = ((await ask(`  toggle which brain [${BRAIN_IDS.join('/')}]: `)) ?? '').trim() as BrainId;
      if (BRAIN_IDS.includes(pick)) {
        if (!cfg.brains[pick].enabled && !isInstalled(cfg.brains[pick].command)) {
          console.log(c.dim(`  ${cfg.brains[pick].label} is not installed. Run "holt init" to install it.`));
        } else {
          cfg.brains[pick].enabled = !cfg.brains[pick].enabled;
          if (!cfg.brains[pick].enabled && cfg.defaultBrain === pick) cfg.defaultBrain = selectableIds(cfg)[0] ?? null;
          if (cfg.brains[pick].enabled && !cfg.defaultBrain) cfg.defaultBrain = pick;
          console.log(c.dim(`  ${cfg.brains[pick].label} is now ${cfg.brains[pick].enabled ? 'on' : 'off'}.`));
        }
      } else console.log(c.dim('  unchanged.'));
    } else if (choice === 'c') {
      await connectApiBrain(ask, cfg);
      if (!cfg.defaultBrain && cfg.apiBrains.length) cfg.defaultBrain = cfg.apiBrains[cfg.apiBrains.length - 1]?.id ?? null;
    } else if (choice === 'x') {
      if (cfg.apiBrains.length === 0) { console.log(c.dim('  no API brains to remove.')); continue; }
      const pick = ((await ask(`  remove which API brain [${cfg.apiBrains.map((a) => a.id).join('/')}]: `)) ?? '').trim();
      const idx = cfg.apiBrains.findIndex((a) => a.id === pick);
      if (idx >= 0) {
        cfg.apiBrains.splice(idx, 1);
        if (cfg.defaultBrain === pick) cfg.defaultBrain = selectableIds(cfg)[0] ?? null;
        console.log(c.dim(`  removed "${pick}". (its stored key, if any, stays in ~/.holt/credentials.json)`));
      } else console.log(c.dim('  unchanged.'));
    } else if (choice === 'a') {
      const name = ((await ask('  launch command (blank to reset to holt): ')) ?? '').trim();
      if (name && name !== 'holt') {
        if (isInstalled(name)) console.log(c.dim(`  note: "${name}" already exists; the alias will shadow it in new shells.`));
        const r = installAlias(name);
        console.log(r.ok ? c.green(`  alias "${name}" -> holt chat added to ${r.file} (run: source ${r.file})`) : c.red('  ' + r.message));
      } else {
        removeAlias();
        console.log(c.dim('  reset to holt.'));
      }
    } else {
      console.log(c.dim('  pick d, t, c, x, a, or press enter to finish.'));
    }
    saveConfig(cfg);
  }
  saveConfig(cfg);
  return cfg;
}

/** `holt setting` entry point. */
export async function setting(): Promise<void> {
  const { ask, close } = createReader();
  if (!(await ensureTrusted(ask))) { close(); return; }
  await runSettings(ask);
  close();
  console.log('');
}
