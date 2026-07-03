/**
 * `holt notify [message]`: push a one-off message to your phone over Telegram.
 *
 * Message source, in order:
 *   - a non-flag argument (joined with spaces), unless it is "-"
 *   - otherwise stdin (used when the arg is "-" or when stdin is piped)
 *
 * Meant for scheduled jobs and pipelines, e.g.
 *   holt run "daily brief" | holt notify
 *   holt notify "backup finished"
 */
import { readFileSync } from 'node:fs';
import { loadTelegramConfig, sendMessage } from '../telegram';

export async function notify(args: string[]): Promise<void> {
  const nonFlag = args.filter((a) => a !== '-' && !a.startsWith('--'));
  const wantsStdin = args.includes('-') || !process.stdin.isTTY;

  let message = '';
  if (nonFlag.length > 0 && !args.includes('-')) {
    message = nonFlag.join(' ').trim();
  } else if (wantsStdin) {
    message = readStdin().trim();
  } else if (nonFlag.length > 0) {
    message = nonFlag.join(' ').trim();
  }

  if (!message) {
    process.stderr.write('Nothing to send. Pass a message or pipe text into "holt notify".\n');
    process.exitCode = 1;
    return;
  }

  const cfg = loadTelegramConfig();
  if (!cfg) {
    process.stderr.write('Telegram is not set up. Run "holt telegram setup".\n');
    process.exitCode = 1;
    return;
  }

  const ok = await sendMessage(message, cfg.allowedChatId);
  if (ok) {
    process.stderr.write('Sent to Telegram.\n');
  } else {
    process.stderr.write('Failed to send to Telegram. Check the network and your bot token.\n');
    process.exitCode = 1;
  }
}

/** Read all of stdin synchronously (fd 0). Returns '' if none/unavailable. */
function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
