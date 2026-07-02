import { loadConfig, BRAIN_IDS, type BrainId } from '../config';
import { isInstalled, renderPrompt, runBrain, type Turn } from '../brains';
import { runSettings } from './setting';
import { init } from './init';
import { ensureTrusted } from '../workspace';
import { c, createReader } from '../ui';

function help(): void {
  console.log(c.dim([
    '  commands:',
    '    /brain [name]   switch brain (claude, codex, gemini). context is kept.',
    '    /setting        configure brains and your launch command',
    '    /clear          forget the conversation so far',
    '    /help           this list',
    '    /exit           leave',
  ].join('\n')));
}

/** `holt chat`: interactive session with in-chat brain switching that preserves context. */
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
  const history: Turn[] = [];

  console.log('\n' + c.accent('Holt') + c.dim(`  brain: ${cfg.brains[current].label}`));
  console.log(c.dim('Type a message. Commands: /brain  /setting  /clear  /help  /exit\n'));

  while (true) {
    const raw = await ask(c.accent('› '));
    if (raw === null) break; // EOF
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      const parts = line.slice(1).split(/\s+/);
      const cmd = (parts[0] || '').toLowerCase();
      const arg = (parts[1] || '').toLowerCase();

      if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') break;
      if (cmd === 'help' || cmd === 'h') { help(); continue; }
      if (cmd === 'clear') { history.length = 0; console.log(c.dim('  context cleared.')); continue; }

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

    console.log(c.dim(`  ${brain.label} is thinking...`));
    const res = await runBrain(brain, renderPrompt(history, line));
    if (res.ok) {
      history.push({ role: 'user', content: line });
      history.push({ role: 'assistant', content: res.text });
      console.log('\n' + res.text + '\n');
    } else {
      console.log(c.red('\n  ' + res.text + '\n'));
    }
  }

  close();
  console.log(c.dim('\nBye.\n'));
}
