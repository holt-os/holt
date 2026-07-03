/**
 * `holt telegram [setup]`: chat with Holt from your phone via a Telegram bot.
 *
 *   holt telegram setup   one-time: paste a @BotFather token, auto-detect chat id
 *   holt telegram         run the bot: long-poll and answer messages via runTask
 *
 * The bot is single user: only the allowed chat id is served. Incoming text is
 * run through the selected brain (runTask); the reply is sent back to Telegram.
 */
import { createReader, c, type Ask } from '../ui';
import { isTrusted, trustDir, workspace } from '../workspace';
import { runTask } from '../runner';
import {
  loadTelegramConfig,
  saveTelegramConfig,
  getUpdates,
  sendMessage,
  type TelegramConfig,
  type TgUpdate,
} from '../telegram';

const HELP_TEXT =
  'Holt bot. Send me anything and I will run it through your selected brain and reply.\n' +
  'Commands: /help this message.';

export async function telegram(sub?: string, _rest: string[] = []): Promise<void> {
  const action = (sub || '').toLowerCase();
  if (action === 'setup') {
    await setup();
    return;
  }
  await runBot();
}

// ---- setup (reusable) ----

/**
 * Interactive Telegram setup using a caller-provided prompt, so it works
 * standalone (holt telegram setup) and inside init / settings. Returns true if
 * a config was saved. Entering an empty token skips without an error.
 */
export async function setupTelegram(ask: Ask): Promise<boolean> {
  console.log('\n' + c.accent('Connect Holt to Telegram') + c.dim('  (chat with Holt from your phone)'));
  console.log(c.dim('  1. Open Telegram and message @BotFather.'));
  console.log(c.dim('  2. Send /newbot, follow the prompts, and copy the bot token it gives you.'));
  console.log(c.dim('     A token looks like 123456789:AAF...  (keep it secret).'));

  const token = ((await ask('\n  Paste your bot token (enter to skip): ')) ?? '').trim();
  if (!token) {
    console.log(c.dim('  Skipped. Set it up later with "holt telegram setup" or in "holt setting".'));
    return false;
  }

  console.log('\n' + c.dim('  Now I need your chat id (so the bot only answers you).'));
  console.log(c.dim('  Option A: open your new bot in Telegram and send it any message,'));
  console.log(c.dim('            then I will auto-detect the chat id.'));
  console.log(c.dim('  Option B: paste a numeric chat id yourself.'));

  const mode = ((await ask('\n  Auto-detect from a message you just sent? [Y/n] ')) ?? '')
    .trim()
    .toLowerCase();

  let allowedChatId: number | null = null;
  if (mode === '' || mode === 'y' || mode === 'yes') {
    // Save token temporarily so getUpdates can read it.
    saveTelegramConfig({ token, allowedChatId: 0 });
    console.log(c.dim('\n  Checking for a recent message...'));
    const updates = await getUpdates(0);
    allowedChatId = latestChatId(updates);
    if (allowedChatId === null) {
      console.log(c.red('  Did not find a recent message.'));
      const manual = ((await ask('  Paste your numeric chat id instead: ')) ?? '').trim();
      allowedChatId = parseChatId(manual);
    }
  } else {
    const manual = ((await ask('  Paste your numeric chat id: ')) ?? '').trim();
    allowedChatId = parseChatId(manual);
  }

  if (allowedChatId === null) {
    console.log(c.red('\n  No valid chat id. Nothing saved. Try again anytime.'));
    return false;
  }

  const cfg: TelegramConfig = { token, allowedChatId };
  saveTelegramConfig(cfg);
  console.log(
    '\n' +
      c.green('  Telegram connected.') +
      c.dim(` token ...${token.slice(-4)}  chat id ${allowedChatId}  (~/.holt/telegram.json, mode 600)`),
  );
  console.log(c.dim('  Start the bot anytime with: holt telegram'));
  return true;
}

async function setup(): Promise<void> {
  const { ask, close } = createReader();
  try {
    await setupTelegram(ask);
    console.log('');
  } finally {
    close();
  }
}

function parseChatId(s: string): number | null {
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The chat id of the most recent update that carries a message. */
function latestChatId(updates: TgUpdate[]): number | null {
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i];
    if (u && u.message) return u.message.chat.id;
  }
  return null;
}

// ---- run loop ----

async function runBot(): Promise<void> {
  const cfg = loadTelegramConfig();
  if (!cfg) {
    console.log(c.dim('\n  Telegram is not set up. Run "holt telegram setup" first.\n'));
    return;
  }

  // Non-interactive process: auto-trust the folder so runTask can read/write here.
  if (!isTrusted()) {
    trustDir();
    process.stderr.write(`[telegram] auto-trusted ${workspace()}\n`);
  }

  process.stderr.write('[telegram] bot started; long-polling for messages. Ctrl-C to stop.\n');

  let offset = 0;
  let busy = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let updates: TgUpdate[] = [];
    try {
      updates = await getUpdates(offset);
    } catch (err) {
      process.stderr.write(`[telegram] poll error: ${(err as Error).message}\n`);
      await sleep(1000);
      continue;
    }

    for (const u of updates) {
      // Always advance the offset so a bad update is not reprocessed forever.
      if (u && typeof u.update_id === 'number') offset = Math.max(offset, u.update_id + 1);
      try {
        await handleUpdate(u, cfg, () => busy, (v) => {
          busy = v;
        });
      } catch (err) {
        process.stderr.write(`[telegram] update ${u?.update_id} failed: ${(err as Error).message}\n`);
      }
    }
  }
}

async function handleUpdate(
  u: TgUpdate,
  cfg: TelegramConfig,
  getBusy: () => boolean,
  setBusy: (v: boolean) => void,
): Promise<void> {
  const msg = u?.message;
  if (!msg || typeof msg.text !== 'string') return;
  if (msg.chat.id !== cfg.allowedChatId) {
    process.stderr.write(`[telegram] ignoring message from chat ${msg.chat.id}\n`);
    return;
  }

  const text = msg.text.trim();
  if (text === '/start' || text === '/help') {
    await sendMessage(HELP_TEXT, cfg.allowedChatId);
    return;
  }

  if (getBusy()) {
    await sendMessage('Still working on the previous message. Try again in a moment.', cfg.allowedChatId);
    return;
  }

  setBusy(true);
  try {
    process.stderr.write(`[telegram] running task (${text.length} chars)\n`);
    const result = await runTask(text);
    await sendMessage(result.text || 'No output.', cfg.allowedChatId);
    process.stderr.write(`[telegram] replied (brain: ${result.brainLabel})\n`);
  } catch (err) {
    process.stderr.write(`[telegram] runTask failed: ${(err as Error).message}\n`);
    await sendMessage('Sorry, that run failed. Check the Holt logs.', cfg.allowedChatId);
  } finally {
    setBusy(false);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
