#!/usr/bin/env node
/**
 * Holt: an open-source personal agent OS.
 * Phase 0: CLI skeleton. Commands are stubbed until the core lands.
 */

const VERSION = "0.0.1";

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
Usage: holt <command> [options]

Commands:
  init            Set up your brain (LLM) and memory (local or cloud)
  chat            Start an interactive session
  skill <cmd>     Manage skills: search | add | remove | list | publish
  version         Print the Holt version
  help            Show this help

Docs: https://productsdecoded.com/holt
Repo: https://github.com/holt-os/holt

Holt is in early development (Phase 0). Most commands are not wired up yet.
`;

function notReady(cmd: string): void {
  console.log(`\n  "${cmd}" is not implemented yet. Holt is in Phase 0 (skeleton).`);
  console.log("  Follow progress: https://github.com/holt-os/holt\n");
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      break;

    case "version":
    case "-v":
    case "--version":
      console.log(`holt ${VERSION}`);
      break;

    case "init":
    case "chat":
    case "skill":
      notReady([cmd, ...rest].join(" "));
      break;

    default:
      console.log(`\n  Unknown command: "${cmd}"`);
      console.log(`  Run "holt help" for usage.\n`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2));
