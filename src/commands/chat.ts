import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig, BRAIN_IDS, findApiBrain, resolveApiKey, type BrainId, type ApiBrain, type HoltConfig, type OutputFormat } from '../config';
import { isInstalled, renderPrompt, runBrain, MAX_REPLAY_TURNS, type Turn } from '../brains';
import { runApiBrain } from '../apibrain';
import { recall, appendTurn, embed, embeddingsAvailable, memStats, newSessionId } from '../memory';
import { extractAndSaveFacts } from '../facts';
import { syncWiki, resolveBrainMaintainer } from '../wiki';
import { saveReply } from '../output';
import { listSkills, skillsPromptBlock, resolveSkillInvocation } from '../skills';
import { runSettings } from './setting';
import { init } from './init';
import { ensureTrusted, workspace } from '../workspace';
import { findOutsidePaths, resolveGrantDir, claudeAccessArgs } from '../access';
import { c, createReader, createStatusBar, bar } from '../ui';

/**
 * A one-line status bar: brain, the recent-replay window as a count, and the
 * saved-memory size. The fill bar maps directly to "recent N/12" (how much of
 * the verbatim replay window is in use). This is NOT the model's context
 * window: Holt sends a small prompt each turn, so real context usage stays low.
 */
function statusLine(brainLabel: string, history: Turn[]): string {
  const live = Math.min(history.length, MAX_REPLAY_TURNS);
  const frac = MAX_REPLAY_TURNS ? live / MAX_REPLAY_TURNS : 0;
  const mem = memStats().turns;
  return (
    c.dim('  ' + brainLabel + '  ') +
    c.dim('[') + bar(frac) + c.dim(']') +
    c.dim(`  recent ${live}/${MAX_REPLAY_TURNS}  ·  ${mem} in memory`)
  );
}

/**
 * The set of recognized slash commands (first token, lowercased) and their
 * aliases. A line starting with "/" is treated as a command ONLY when its first
 * token is in here; anything else (a file path like /Users/..., a URL fragment,
 * or a mistyped command) is sent to the brain verbatim instead of being dropped.
 */
const KNOWN_COMMANDS = new Set<string>([
  'exit', 'quit', 'q',
  'help', 'h',
  'clear',
  'memory', 'mem',
  'output',
  'save',
  'setting', 'settings',
  'brain',
  'skill', 'skills',
  'allow', 'allowed',
]);

function help(): void {
  console.log(c.dim([
    '  commands:',
    '    /brain [name]     switch brain (CLI or API). context is kept.',
    '    /memory [query]   memory stats, or preview what a query would recall',
    '    /skill [name] [input]  run a skill, or list them. "holt skill" manages them.',
    '    /output [fmt]     show or set output format: markdown | html',
    '    /save [name]      save the last reply to a file in this folder',
    '    /allow [path]     let this session read a folder outside this one (session-only)',
    '    /allowed          list folders granted outside-access this session',
    '    /setting          configure brains, API brains, and your launch command',
    '    /clear            forget this session so far (saved memory stays)',
    '    /help             this list',
    '    /exit             leave',
  ].join('\n')));
}

/** A resolved brain to dispatch to: either a CLI brain or an API brain. */
type Active =
  | { kind: 'cli'; id: BrainId; label: string }
  | { kind: 'api'; id: string; label: string; brain: ApiBrain };

function resolveActive(cfg: HoltConfig, id: string): Active | null {
  if ((BRAIN_IDS as string[]).includes(id)) {
    const b = cfg.brains[id as BrainId];
    return { kind: 'cli', id: id as BrainId, label: b.label };
  }
  const api = findApiBrain(cfg, id);
  if (api) return { kind: 'api', id, label: `${id} (api: ${api.provider}/${api.model})`, brain: api };
  return null;
}

/** `holt chat`: interactive session with persistent memory and brain switching. */
export async function chat(): Promise<void> {
  const { ask, close } = createReader();

  if (!(await ensureTrusted(ask))) { close(); return; }

  let cfg = loadConfig();
  if (!cfg || !cfg.defaultBrain) {
    const a = ((await ask(c.dim('No Holt setup in this folder. Set it up now? [Y/n] '))) ?? '').trim().toLowerCase();
    close();
    if (a === 'n' || a === 'no') { console.log(c.dim('  Run "holt init" here when ready.\n')); return; }
    await init();
    console.log(c.dim('\nSetup done. Run "holt chat" to start talking.\n'));
    return;
  }

  let active = resolveActive(cfg, cfg.defaultBrain);
  if (!active) {
    // Default points at something no longer available; fall back to any enabled CLI brain.
    const fallback = BRAIN_IDS.find((id) => (cfg as HoltConfig).brains[id].enabled) ?? cfg.apiBrains[0]?.id ?? null;
    active = fallback ? resolveActive(cfg, fallback) : null;
    if (!active) { close(); console.log(c.dim('\nNo brain is ready. Run "holt setting".\n')); return; }
  }

  const session = newSessionId();
  const history: Turn[] = [];
  let lastReply = '';

  // In-memory, session-scoped grants for reading folders OUTSIDE this workspace.
  // Never persisted; resets on the next `holt chat`. Default deny (empty).
  const grantedDirs = new Set<string>();

  // Sticky bottom status bar on a TTY; a printed line per reply otherwise. The
  // sticky bar redraws in place (no scroll-spam); the non-TTY path preserves the
  // original behavior exactly, so piped/CI runs emit no escape codes.
  const sb = createStatusBar();
  const showStatus = (): void => {
    const line = statusLine(active!.label, history);
    if (sb.active) sb.set(line);
    else console.log(line + '\n');
  };

  const embedOk = await embeddingsAvailable();
  const stats = memStats();
  console.log('\n' + c.accent('Holt') + c.dim(`  brain: ${active.label}`));
  console.log(c.dim(
    `Memory: ${stats.turns} moments (${stats.facts} facts) from ${stats.sessions} session${stats.sessions === 1 ? '' : 's'} in this folder` +
    ` (recall: ${embedOk ? 'embeddings via local Ollama' : 'keyword match'}).`,
  ));
  if (embedOk && stats.withEmbeddings < stats.turns) {
    console.log(c.dim(`  ${stats.turns - stats.withEmbeddings} older moments lack embeddings. Run "holt memory embed" to upgrade them.`));
  }
  console.log(c.dim('Type a message. Commands: /brain  /memory  /output  /save  /allow  /setting  /clear  /help  /exit'));
  showStatus();

  while (true) {
    const raw = await ask(c.accent('› '));
    if (raw === null) break; // EOF
    const line = raw.trim();
    if (!line) continue;

    // "/skill <name> [input]" becomes a prompt but flows through the normal
    // send path below, so it streams and lands in memory like any message.
    let promptOverride: string | null = null;
    if (/^\/skills?\s+\S/.test(line)) {
      const inv = resolveSkillInvocation(line.replace(/^\/skills\b/, '/skill'));
      if (!inv) { console.log(c.dim('  no such skill. Try "holt skill list".')); continue; }
      promptOverride = inv.prompt;
      console.log(c.dim(`  running skill "${inv.skillName}"...`));
    } else if (line.startsWith('/') && KNOWN_COMMANDS.has((line.slice(1).split(/\s+/)[0] || '').toLowerCase())) {
      // A line starting with "/" is a command ONLY when its first token is a
      // known command. Otherwise it falls through to the brain (see below), so a
      // message like "/Users/.../resume.docx summarize this" is never dropped.
      const parts = line.slice(1).split(/\s+/);
      const cmd = (parts[0] || '').toLowerCase();
      const rest = parts.slice(1).join(' ');
      const arg = (parts[1] || '').toLowerCase();

      if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') break;
      if (cmd === 'help' || cmd === 'h') { help(); continue; }
      if (cmd === 'clear') { history.length = 0; console.log(c.dim('  session context cleared. Saved memory is untouched.')); continue; }

      if (cmd === 'memory' || cmd === 'mem') {
        if (rest) {
          const hits = await recall(rest, session, 5);
          if (hits.length === 0) console.log(c.dim('  nothing relevant in memory for that.'));
          else for (const h of hits) console.log(c.dim(`  ${(h.score).toFixed(2)}  (${h.turn.role}) ${h.turn.content.slice(0, 110).replace(/\s+/g, ' ')}`));
        } else {
          const s = memStats();
          console.log(c.dim(`  ${s.turns} moments, ${s.facts} facts, ${s.sessions} sessions, ${s.withEmbeddings} embedded, ${(s.bytes / 1024).toFixed(1)} KB in ./.holt/memory/`));
          console.log(c.dim('  usage: /memory <query> to preview recall, or "holt memory clear" to wipe.'));
        }
        continue;
      }

      if (cmd === 'output') {
        const want = arg;
        if (want === 'markdown' || want === 'md') { cfg.outputFormat = 'markdown'; saveConfig(cfg); console.log(c.green('  output format: markdown')); }
        else if (want === 'html') { cfg.outputFormat = 'html'; saveConfig(cfg); console.log(c.green('  output format: html')); }
        else if (want) console.log(c.dim('  usage: /output markdown | html'));
        else console.log(c.dim(`  output format: ${cfg.outputFormat}  (change with /output markdown | html)`));
        continue;
      }

      if (cmd === 'save') {
        if (!lastReply) { console.log(c.dim('  nothing to save yet. Ask something first.')); continue; }
        try {
          const path = saveReply(lastReply, cfg.outputFormat, rest || undefined);
          console.log(c.green(`  saved ${cfg.outputFormat} to ${path}`));
        } catch (e) {
          console.log(c.red(`  could not save: ${(e as Error).message}`));
        }
        continue;
      }

      if (cmd === 'setting' || cmd === 'settings') {
        cfg = await runSettings(ask);
        const next = cfg.defaultBrain ? resolveActive(cfg, cfg.defaultBrain) : null;
        // Keep current brain if still valid, else adopt default.
        const stillValid = resolveActive(cfg, active.id);
        active = stillValid ?? next ?? active;
        console.log(c.dim(`  brain: ${active.label}`));
        continue;
      }

      if (cmd === 'brain') {
        const cliEnabled = BRAIN_IDS.filter((id) => (cfg as HoltConfig).brains[id].enabled) as string[];
        const apiIds = cfg.apiBrains.map((a) => a.id);
        const all = [...cliEnabled, ...apiIds];
        // Match case-insensitively but resolve to the real stored id: API brain
        // ids are case-preserving, so lowercasing the arg alone would make a
        // mixed-case brain unswitchable even though it is listed as available.
        const rawArg = parts[1] || '';
        const match = all.find((id) => id.toLowerCase() === rawArg.toLowerCase());
        if (rawArg && match) {
          const next = resolveActive(cfg, match);
          if (next) {
            active = next;
            const turns = Math.floor(history.length / 2);
            console.log(c.green(`  switched to ${active.label}. Context kept (${turns} turn${turns === 1 ? '' : 's'}).`));
          }
        } else if (rawArg) {
          console.log(c.dim(`  "${rawArg}" is not available. Available: ${all.join(', ') || 'none'}`));
        } else {
          const cfgRef = cfg;
          const activeId = active.id;
          const labels = all.map((id) => {
            const a = findApiBrain(cfgRef, id);
            const shown = a ? `${id} (api: ${a.provider}/${a.model})` : id;
            return id === activeId ? c.accent(shown + ' (current)') : shown;
          });
          console.log(c.dim('  brains: ' + labels.join('   ')));
          console.log(c.dim('  usage: /brain <name>'));
        }
        continue;
      }

      if (cmd === 'skill' || cmd === 'skills') {
        const names = listSkills().map((s) => s.name);
        console.log(c.dim('  skills: ' + (names.join('  ') || 'none') + '   usage: /skill <name> [input]'));
        continue;
      }

      if (cmd === 'allowed') {
        if (grantedDirs.size === 0) console.log(c.dim('  no folders outside this one are granted this session.'));
        else {
          console.log(c.dim('  granted this session (read-only):'));
          for (const d of grantedDirs) console.log(c.dim(`    ${d}`));
        }
        continue;
      }

      if (cmd === 'allow') {
        if (!rest) { console.log(c.dim('  usage: /allow <path>   (grants that path\'s folder read access for this session)')); continue; }
        const dir = resolveGrantDir(rest);
        grantedDirs.add(dir);
        console.log(c.green(`  granted this session: ${dir}`));
        continue;
      }

      // Unreachable in practice: the branch is gated on KNOWN_COMMANDS, so every
      // command above has a handler. Kept as a defensive fallthrough.
      console.log(c.dim(`  unknown command: /${cmd}  (try /help)`));
      continue;
    }

    // Guard against a CLI brain whose command vanished.
    if (active.kind === 'cli' && !isInstalled(cfg.brains[active.id].command)) {
      console.log(c.red(`  ${active.label} (${cfg.brains[active.id].command}) is not on your PATH. Use /brain to switch or /setting.`));
      continue;
    }
    if (active.kind === 'api' && !resolveApiKey(active.brain)) {
      console.log(c.red(`  ${active.label} has no API key. Use /setting to add one, or /brain to switch.`));
      continue;
    }

    // External-folder access. If the message references absolute paths that exist
    // OUTSIDE this workspace, ask once per new directory before granting the brain
    // read access. Default deny; a "no" simply means the brain does not get access
    // and we do NOT block the message. Skipped for /skill prompt overrides.
    if (promptOverride === null) {
      const outside = findOutsidePaths(line, workspace());
      for (const dir of outside) {
        if (grantedDirs.has(dir)) continue; // already granted this session; no re-prompt
        const ans = ((await ask(c.dim(`  Allow this session to access ${dir} (outside this folder)? [y/N] `))) ?? '').trim().toLowerCase();
        if (ans === 'y' || ans === 'yes') {
          grantedDirs.add(dir);
          console.log(c.green(`  granted this session: ${dir}`));
        } else {
          console.log(c.dim('  not granted.'));
        }
      }
    }

    const remembered = await recall(line, session, 4);
    // Branding: the pre-reply status line is always "Holt is thinking", never the
    // underlying brain's label, so chat feels like Holt. The active brain still
    // shows in the sticky status bar.
    const label = remembered.length
      ? `Holt is thinking (recalled ${remembered.length} moment${remembered.length === 1 ? '' : 's'})...`
      : `Holt is thinking...`;
    console.log(c.dim(`  ${label}`) + '\n');

    const skillsBlock = skillsPromptBlock();
    const base = renderPrompt(history, line, remembered);
    const prompt = promptOverride ?? (skillsBlock ? skillsBlock + '\n\n' + base : base);

    // Turn granted outside-dirs into brain flags. Only the Claude Code CLI brain
    // (command "claude") supports file-tool scoping via --add-dir; for other CLI
    // brains (Codex/Gemini) or API brains, external file access is not available,
    // so we print a one-line note and add no flags.
    let extraArgs: string[] = [];
    if (grantedDirs.size > 0) {
      if (active.kind === 'cli' && cfg.brains[active.id].command === 'claude') {
        extraArgs = claudeAccessArgs(grantedDirs);
      } else {
        console.log(c.dim('  note: external file access is only available with a Claude Code brain; skipping granted folders this turn.'));
      }
    }

    // Stream the reply as it arrives, regardless of brain kind.
    let streamed = false;
    const onChunk = (chunk: string): void => { streamed = true; process.stdout.write(chunk); };
    const res = active.kind === 'cli'
      ? await runBrain(cfg.brains[active.id], prompt, onChunk, extraArgs)
      : await runApiBrain(active.brain, prompt, onChunk);

    if (res.ok) {
      if (!streamed) console.log(res.text);
      if (!res.text.endsWith('\n')) console.log('');
      console.log('');
      lastReply = res.text;
      history.push({ role: 'user', content: line });
      history.push({ role: 'assistant', content: res.text });
      // Persist both turns with embeddings when available.
      const now = Date.now();
      appendTurn({ id: randomUUID().slice(0, 8), ts: now, session, role: 'user', content: line, emb: (await embed(line)) ?? undefined });
      appendTurn({ id: randomUUID().slice(0, 8), ts: now, session, role: 'assistant', content: res.text, emb: (await embed(res.text)) ?? undefined });
      showStatus();
    } else {
      console.log(c.red('\n  ' + res.text + '\n'));
    }
  }

  // Leaving the REPL: tear down the sticky bar first so the closing messages
  // (fact distillation, wiki sync, "Bye.") print on a clean, full-height screen
  // with the cursor restored. No-op on the non-TTY path.
  sb.detach();

  // Distill durable facts from this session before leaving. Silent, best-effort,
  // and never blocks exit: any failure is swallowed inside extractAndSaveFacts.
  if (cfg.memory?.extractFacts !== false) {
    try {
      const arg = active.kind === 'cli'
        ? { kind: 'cli' as const, id: active.id }
        : { kind: 'api' as const, brain: active.brain };
      const n = await extractAndSaveFacts(arg, cfg, history, session);
      if (n > 0) console.log(c.dim(`  distilled ${n} fact${n === 1 ? '' : 's'} from this session.`));
    } catch {
      // never block exit on a memory step
    }
  }

  // Auto-sync the derived wiki AFTER fact extraction, so the new facts fold into
  // pages with no manual "holt wiki sync". Opt-in (wiki.autoSync), silent, and
  // never blocks exit: any failure is swallowed by syncWiki (it never throws).
  if (cfg.wiki?.autoSync) {
    try {
      const res = await syncWiki(cfg, () => resolveBrainMaintainer(cfg));
      if (res.status === 'ok' && res.changed) console.log(c.dim('  updated the wiki.'));
    } catch {
      // never block exit on a wiki step
    }
  }

  close();
  console.log(c.dim('\nBye.\n'));
}
