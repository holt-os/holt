import { randomUUID } from 'node:crypto';
import { loadConfig, BRAIN_IDS, type BrainId } from '../config';
import { isInstalled, renderPrompt, runBrain, type Turn } from '../brains';
import { recall, appendTurn, embed, embeddingsAvailable, memStats, newSessionId } from '../memory';
import { runSettings } from './setting';
import { init } from './init';
import { ensureTrusted } from '../workspace';
import { c, createReader } from '../ui';

function help(): void {
  console.log(c.dim([
    '  commands:',
    '    /brain [name]     switch brain (claude, codex, gemini). context is kept.',
    '    /memory [query]   memory stats, or preview what a query would recall',
    '    /setting          configure brains and your launch command',
    '    /clear            forget this session so far (saved memory stays)',
    '    /help             this list',
    '    /exit             leave',
  ].join('\n')));
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

  let current: BrainId = cfg.defaultBrain;
  const session = newSessionId();
  const history: Turn[] = [];

  const embedOk = await embeddingsAvailable();
  const stats = memStats();
  console.log('\n' + c.accent('Holt') + c.dim(`  brain: ${cfg.brains[current].label}`));
  console.log(c.dim(
    `Memory: ${stats.turns} moments from ${stats.sessions} session${stats.sessions === 1 ? '' : 's'} in this folder` +
    ` (recall: ${embedOk ? 'embeddings via local Ollama' : 'keyword match'}).`,
  ));
  console.log(c.dim('Type a message. Commands: /brain  /memory  /setting  /clear  /help  /exit\n'));

  while (true) {
    const raw = await ask(c.accent('› '));
    if (raw === null) break; // EOF
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('/')) {
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
          console.log(c.dim(`  ${s.turns} moments, ${s.sessions} sessions, ${s.withEmbeddings} embedded, ${(s.bytes / 1024).toFixed(1)} KB in ./.holt/memory/`));
          console.log(c.dim('  usage: /memory <query> to preview recall, or "holt memory clear" to wipe.'));
        }
        continue;
      }

      if (cmd === 'setting' || cmd === 'settings') {
        cfg = await runSettings(ask);
        if (!cfg.brains[current].enabled && cfg.defaultBrain) current = cfg.defaultBrain;
        console.log(c.dim(`  brain: ${cfg.brains[current].label}`));
        continue;
      }

      if (cmd === 'brain') {
        const enabled = BRAIN_IDS.filter((id) => (cfg as NonNullable<typeof cfg>).brains[id].enabled);
        if (arg && (enabled as string[]).includes(arg)) {
          current = arg as BrainId;
          const turns = Math.floor(history.length / 2);
          console.log(c.green(`  switched to ${cfg.brains[current].label}. Context kept (${turns} turn${turns === 1 ? '' : 's'}).`));
        } else if (arg) {
          console.log(c.dim(`  "${arg}" is not available. Installed: ${enabled.join(', ') || 'none'}`));
        } else {
          console.log(c.dim('  brains: ' + enabled.map((id) => (id === current ? c.accent(id + ' (current)') : id)).join('  ')));
          console.log(c.dim('  usage: /brain <name>'));
        }
        continue;
      }

      console.log(c.dim(`  unknown command: /${cmd}  (try /help)`));
      continue;
    }

    const brain = cfg.brains[current];
    if (!isInstalled(brain.command)) {
      console.log(c.red(`  ${brain.label} (${brain.command}) is not on your PATH. Use /brain to switch or /setting.`));
      continue;
    }

    const remembered = await recall(line, session, 4);
    const label = remembered.length
      ? `${brain.label} is thinking (recalled ${remembered.length} moment${remembered.length === 1 ? '' : 's'})...`
      : `${brain.label} is thinking...`;
    console.log(c.dim(`  ${label}`) + '\n');

    // Stream the reply as it arrives.
    let streamed = false;
    const res = await runBrain(brain, renderPrompt(history, line, remembered), (chunk) => {
      streamed = true;
      process.stdout.write(chunk);
    });

    if (res.ok) {
      if (!streamed) console.log(res.text);
      if (!res.text.endsWith('\n')) console.log('');
      console.log('');
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

  close();
  console.log(c.dim('\nBye.\n'));
}
