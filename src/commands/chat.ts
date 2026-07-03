import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig, BRAIN_IDS, findApiBrain, resolveApiKey, type BrainId, type ApiBrain, type HoltConfig, type OutputFormat } from '../config';
import { isInstalled, renderPrompt, runBrain, type Turn } from '../brains';
import { runApiBrain } from '../apibrain';
import { recall, appendTurn, embed, embeddingsAvailable, memStats, newSessionId } from '../memory';
import { extractAndSaveFacts } from '../facts';
import { saveReply } from '../output';
import { listSkills, skillsPromptBlock, resolveSkillInvocation } from '../skills';
import { runSettings } from './setting';
import { init } from './init';
import { ensureTrusted } from '../workspace';
import { c, createReader } from '../ui';

function help(): void {
  console.log(c.dim([
    '  commands:',
    '    /brain [name]     switch brain (CLI or API). context is kept.',
    '    /memory [query]   memory stats, or preview what a query would recall',
    '    /skill [name] [input]  run a skill, or list them. "holt skill" manages them.',
    '    /output [fmt]     show or set output format: markdown | html',
    '    /save [name]      save the last reply to a file in this folder',
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
  console.log(c.dim('Type a message. Commands: /brain  /memory  /output  /save  /setting  /clear  /help  /exit\n'));

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
    } else if (line.startsWith('/')) {
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
        if (arg && all.includes(arg)) {
          const next = resolveActive(cfg, arg);
          if (next) {
            active = next;
            const turns = Math.floor(history.length / 2);
            console.log(c.green(`  switched to ${active.label}. Context kept (${turns} turn${turns === 1 ? '' : 's'}).`));
          }
        } else if (arg) {
          console.log(c.dim(`  "${arg}" is not available. Available: ${all.join(', ') || 'none'}`));
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

    const remembered = await recall(line, session, 4);
    const label = remembered.length
      ? `${active.label} is thinking (recalled ${remembered.length} moment${remembered.length === 1 ? '' : 's'})...`
      : `${active.label} is thinking...`;
    console.log(c.dim(`  ${label}`) + '\n');

    const skillsBlock = skillsPromptBlock();
    const base = renderPrompt(history, line, remembered);
    const prompt = promptOverride ?? (skillsBlock ? skillsBlock + '\n\n' + base : base);

    // Stream the reply as it arrives, regardless of brain kind.
    let streamed = false;
    const onChunk = (chunk: string): void => { streamed = true; process.stdout.write(chunk); };
    const res = active.kind === 'cli'
      ? await runBrain(cfg.brains[active.id], prompt, onChunk)
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
    } else {
      console.log(c.red('\n  ' + res.text + '\n'));
    }
  }

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

  close();
  console.log(c.dim('\nBye.\n'));
}
