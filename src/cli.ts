#!/usr/bin/env node
/**
 * Holt: an open-source personal agent OS.
 * Per-folder trust, brains (CLI and direct API), persistent memory with
 * recall, skills, and a knowledge graph view of everything it remembers.
 */
import { init } from './commands/init';
import { launch } from './commands/launch';
import { chat } from './commands/chat';
import { setting } from './commands/setting';
import { login } from './commands/login';
import { memoryCmd } from './commands/memory';
import { wikiCmd } from './commands/wiki';
import { skillCmd } from './commands/skill';
import { graph } from './commands/graph';
import { mcp } from './commands/mcp';
import { hook } from './commands/hook';
import { statusline } from './commands/statusline';
import { run } from './commands/run';
import { schedule } from './commands/schedule';
import { routine } from './commands/routine';
import { telegram } from './commands/telegram';
import { notify } from './commands/notify';
import { doctor } from './commands/doctor';
import { voice } from './commands/voice';
import { write } from './commands/write';
import { VERSION } from './version';

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
  (no command)    Start your assistant: sets up if needed, then launches the real
                  interactive brain (Claude Code, Codex, Gemini), branded as Holt
  init            Trust this folder, choose and install brains, sign in, set defaults
  launch          Same as bare "holt": start your assistant
  chat            Lightweight REPL that remembers past sessions (used for API brains)
  run <task>      Run one task non-interactively: recall, brain executes, remember
  schedule        Fire "holt run" on a timer: holt schedule [add | list | remove]
  routine         Named, reusable, scheduled jobs: holt routine [add | run | list | remove]
  telegram        Chat with Holt from your phone: holt telegram [setup]
  notify [msg]    Push a message to your phone over Telegram (stdin-friendly)
  voice           Teach Holt how you write: holt voice [add <file> | show | edit | clear]
  write <what>    Draft content in your voice, with anti-AI checks: holt write "..." [--type]
  memory          Inspect memory: holt memory [search <query> | embed | clear]
  wiki            Your derived knowledge wiki: holt wiki [sync | rebuild | lint | list | show]
  graph           See your memory as an interactive knowledge graph in the browser
  skill           Manage skills: holt skill [list | show | create | add | remove]
  doctor          Check this machine and recommend how best to run Holt here
  mcp             Serve this folder's memory to Claude Code, Cursor, Codex (holt mcp setup)
  hook            Ambient memory for Claude Code: holt hook [install | remove | status]
  setting         Configure brains, API brains, and your launch command (per folder)
  login <brain>   Sign in to a brain: claude, codex, or gemini
  version         Print the Holt version
  help            Show this help (bare "holt" starts your assistant, not this)

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
      // Bare `holt` starts your assistant: auto-setup, then the real interactive
      // brain, branded as Holt. `holt help` (below) shows usage.
      await launch();
      break;
    case 'launch':
      await launch();
      break;
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
    case 'wiki':
      await wikiCmd(process.argv[3], process.argv.slice(4));
      break;
    case 'skill':
    case 'skills':
      await skillCmd(process.argv[3], process.argv.slice(4));
      break;
    case 'graph':
      await graph(process.argv.slice(3));
      break;
    case 'mcp':
      await mcp(process.argv[3], process.argv.slice(4));
      break;
    case 'hook':
      await hook(process.argv[3], process.argv.slice(4));
      break;
    case 'statusline':
      // Internal/plumbing: Claude Code invokes this via a project statusLine set
      // by launch's brandStatusLine. It reads a status JSON off stdin and prints
      // one line ("Holt · folder · model"). Not in HELP on purpose.
      await statusline();
      break;
    case 'run':
      await run(process.argv.slice(3));
      break;
    case 'schedule':
      await schedule(process.argv[3], process.argv.slice(4));
      break;
    case 'routine':
      await routine(process.argv[3], process.argv.slice(4));
      break;
    case 'telegram':
      await telegram(process.argv[3], process.argv.slice(4));
      break;
    case 'notify':
      await notify(process.argv.slice(3));
      break;
    case 'doctor':
      await doctor();
      break;
    case 'voice':
      await voice(process.argv[3], process.argv.slice(4));
      break;
    case 'write':
      await write(process.argv.slice(3));
      break;
    default:
      console.error(`\n  Unknown command: "${cmd}"`);
      console.error(`  Run "holt help" for usage.\n`);
      process.exitCode = 1;
  }
}

main();
