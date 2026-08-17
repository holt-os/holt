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
import { tour } from './commands/tour';
import { reset } from './commands/reset';
import { update } from './commands/update';
import { voice } from './commands/voice';
import { write } from './commands/write';
import { VERSION } from './version';
import { setQuietMode } from './ui';
import { handleCrash } from './crash';

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

Start here:
  (no command)    Start your assistant: sets up if needed, then launches your
                  brain (Claude Code, Codex, Gemini), branded as Holt
  tour            A 2-minute guided first run: ask, teach it one fact, watch it remember
  doctor          Health check for this machine
                  ("holt doctor --fix" also repairs the common problems for you)

Every day:
  run <task>      Do one task and remember it: holt run "draft my status update"
  write <what>    Draft content in your voice, with anti-AI checks: holt write "..." [--type]
  voice           Teach Holt how you write: holt voice [add <file> | show | edit | clear]
  memory          What Holt knows here: holt memory [search <q> | facts | embed | clear]
  wiki            A tidy, linked notebook Holt keeps from your memory: holt wiki [sync | show]
  graph           See everything Holt knows as a visual map in your browser
  skill           Reusable how-tos you can share: holt skill [list | show | create | add]

From your phone, while you sleep:
  telegram        Chat with Holt from your phone: holt telegram setup
  notify [msg]    Send yourself a phone message from any script (stdin-friendly)
  schedule        Run a task on a timer: holt schedule [add | list | remove]
  routine         Named, reusable, scheduled jobs: holt routine [add | run | list | remove]

Housekeeping:
  setting         Change brains, API connections, and your launch word (per folder)
  login <brain>   Sign in to a brain: claude, codex, or gemini
  update          Get the latest Holt, in one word
  reset           Start this folder over (asks first; your own files are untouched)
  hook            Ambient memory inside plain Claude Code: holt hook [install | status]
  mcp             Share Holt's memory with other AI apps (Claude Code, Cursor, Codex)
  chat            Lightweight built-in chat, used for API brains
  init            Full setup by hand (bare "holt" runs this for you when needed)
  launch          Same as bare "holt": start your assistant
  version | help  Print the version / show this help

Holt runs in the folder you launch it from and asks to trust it first.
A "brain" is the AI doing the thinking: an agent CLI on your machine
(claude, codex, gemini) or a direct API connection you add in settings.

Docs: https://productsdecoded.com/holt
Repo: https://github.com/holt-os/holt
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  // Plumbing commands whose output another program consumes: suppress
  // incidental human-facing notes (config repair, hints) so we never corrupt
  // a status line, an MCP stream, or a hook payload.
  const sub = process.argv[3];
  if (
    cmd === 'statusline' ||
    cmd === 'mcp' ||
    cmd === 'notify' ||
    (cmd === 'hook' && (sub === 'inject' || sub === 'capture'))
  ) {
    setQuietMode(true);
  }
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
      await doctor(process.argv.slice(3));
      break;
    case 'tour':
      await tour();
      break;
    case 'reset':
      await reset();
      break;
    case 'update':
      await update();
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

// No raw stack traces, ever: anything a command did not catch lands in the
// crash handler, which logs the detail and prints a short human note.
process.on('uncaughtException', handleCrash);
process.on('unhandledRejection', handleCrash);
main().catch(handleCrash);
