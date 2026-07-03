#!/usr/bin/env node
/**
 * Holt: an open-source personal agent OS.
 * Per-folder trust, brains (CLI and direct API), persistent memory with
 * recall, skills, and a knowledge graph view of everything it remembers.
 */
import { init } from './commands/init';
import { chat } from './commands/chat';
import { setting } from './commands/setting';
import { login } from './commands/login';
import { memoryCmd } from './commands/memory';
import { skillCmd } from './commands/skill';
import { graph } from './commands/graph';

const VERSION = '0.6.0';

const BANNER = `
  ██╗  ██╗ ██████╗ ██╗  ████████╗
  ██║  ██║██╔═══██╗██║  ╚══██╔══╝
  ███████║██║   ██║██║     ██║
  ██╔══██║██║   ██║██║     ██║
  ██║  ██║╚██████╔╝███████╗██║
  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝
  Everything you know, kept and connected.
`;

const HELP = `${BANNER}
Usage: holt <command>

Commands:
  init            Trust this folder, choose and install brains, sign in, set defaults
  chat            Start a session. It remembers past sessions in this folder
  memory          Inspect memory: holt memory [search <query> | embed | clear]
  graph           See your memory as an interactive knowledge graph in the browser
  skill           Manage skills: holt skill [list | show | create | add | remove]
  setting         Configure brains, API brains, and your launch command (per folder)
  login <brain>   Sign in to a brain: claude, codex, or gemini
  version         Print the Holt version
  help            Show this help

Holt runs in the folder you launch it from and asks to trust it first.
Brains are agent CLIs on your machine (claude, codex, gemini) or direct
API connections you add in settings.

Docs: https://productsdecoded.com/holt
Repo: https://github.com/holt-os/holt
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      break;
    case 'version':
    case '-v':
    case '--version':
      console.log(`holt ${VERSION}`);
      break;
    case 'init':
      await init();
      break;
    case 'chat':
      await chat();
      break;
    case 'setting':
    case 'settings':
      await setting();
      break;
    case 'login':
      await login(process.argv[3]);
      break;
    case 'memory':
      await memoryCmd(process.argv[3], process.argv.slice(4));
      break;
    case 'skill':
    case 'skills':
      await skillCmd(process.argv[3], process.argv.slice(4));
      break;
    case 'graph':
      await graph(process.argv.slice(3));
      break;
    default:
      console.log(`\n  Unknown command: "${cmd}"`);
      console.log(`  Run "holt help" for usage.\n`);
      process.exitCode = 1;
  }
}

main();
