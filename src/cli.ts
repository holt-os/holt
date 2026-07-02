#!/usr/bin/env node
/**
 * Holt: an open-source personal agent OS.
 * Phase 0: init, chat (with in-conversation brain switching), and settings.
 */
import { init } from './commands/init';
import { chat } from './commands/chat';
import { setting } from './commands/setting';

const VERSION = '0.1.0';

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
  init            Detect your agent CLIs, pick a brain, set a launch command
  chat            Start a session. Switch brains mid-chat with /brain, context is kept
  setting         Configure brains and your launch command
  version         Print the Holt version
  help            Show this help

Brains are the agent CLIs on your machine: claude (Claude Code), codex, gemini.

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
    default:
      console.log(`\n  Unknown command: "${cmd}"`);
      console.log(`  Run "holt help" for usage.\n`);
      process.exitCode = 1;
  }
}

main();
