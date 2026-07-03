/**
 * Telegram client and config for Holt. Zero runtime dependencies: uses the
 * global fetch against the Telegram Bot API. Single user: one allowed chat id.
 *
 * Config lives at ~/.holt/telegram.json (mode 0o600) and holds the bot token
 * plus the one chat id Holt will talk to. The bot is a thin transport: incoming
 * messages are run through the selected brain via runTask elsewhere; this file
 * only speaks HTTP.
 *
 * The request builders are pure so they can be tested without a network or a
 * real token.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR } from './workspace';

const API_BASE = 'https://api.telegram.org';
const CHUNK_SIZE = 4000;

export interface TelegramConfig {
  token: string;
  allowedChatId: number;
}

/** Minimal shapes of the Telegram objects we read. */
export interface TgChat {
  id: number;
}
export interface TgMessage {
  chat: TgChat;
  text?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export function telegramConfigPath(): string {
  return join(GLOBAL_DIR, 'telegram.json');
}

export function loadTelegramConfig(): TelegramConfig | null {
  const path = telegramConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TelegramConfig>;
    if (typeof raw.token !== 'string' || typeof raw.allowedChatId !== 'number') return null;
    return { token: raw.token, allowedChatId: raw.allowedChatId };
  } catch {
    return null;
  }
}

/** Write the config with owner-only permissions (0o600). */
export function saveTelegramConfig(cfg: TelegramConfig): void {
  // GLOBAL_DIR is created by trustDir/other flows; ensure it exists here too.
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(telegramConfigPath(), JSON.stringify(cfg, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// ---- pure request builders (network-free, unit-testable) ----

/** Build the POST request for sendMessage. */
export function buildSendRequest(
  token: string,
  chatId: number,
  text: string,
): { url: string; body: string } {
  return {
    url: `${API_BASE}/bot${token}/sendMessage`,
    body: JSON.stringify({ chat_id: chatId, text }),
  };
}

/** Build the long-poll getUpdates URL. */
export function buildGetUpdatesUrl(token: string, offset: number, timeoutSec: number): string {
  const params = new URLSearchParams({
    offset: String(offset),
    timeout: String(timeoutSec),
  });
  return `${API_BASE}/bot${token}/getUpdates?${params.toString()}`;
}

/** Split text into <= size pieces. Pure; rejoining the pieces equals input. */
export function chunk(text: string, size = CHUNK_SIZE): string[] {
  if (text.length === 0) return [''];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// ---- network operations (tolerant: never throw to the caller) ----

/**
 * Send a message to the allowed chat (or an explicit chatId). Long text is split
 * into <=4000 char chunks, each POSTed in order. Returns false on any failure.
 */
export async function sendMessage(text: string, chatId?: number): Promise<boolean> {
  const cfg = loadTelegramConfig();
  if (!cfg) {
    process.stderr.write('[telegram] not configured; run "holt telegram setup"\n');
    return false;
  }
  const target = chatId ?? cfg.allowedChatId;
  const pieces = chunk(text || 'No output.');
  let allOk = true;
  for (const piece of pieces) {
    const { url, body } = buildSendRequest(cfg.token, target, piece);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!res.ok) {
        allOk = false;
        process.stderr.write(`[telegram] sendMessage HTTP ${res.status}\n`);
      }
    } catch (err) {
      allOk = false;
      process.stderr.write(`[telegram] sendMessage failed: ${(err as Error).message}\n`);
    }
  }
  return allOk;
}

/**
 * Long-poll for updates from the given offset. Uses a 30s server-side timeout.
 * Returns the updates array, or [] on any error.
 */
export async function getUpdates(offset: number): Promise<TgUpdate[]> {
  const cfg = loadTelegramConfig();
  if (!cfg) return [];
  const timeoutSec = 30;
  const url = buildGetUpdatesUrl(cfg.token, offset, timeoutSec);
  // Abort a bit after the server-side long-poll window so we do not hang forever.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), (timeoutSec + 10) * 1000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      process.stderr.write(`[telegram] getUpdates HTTP ${res.status}\n`);
      return [];
    }
    const data = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
    if (!data || data.ok !== true || !Array.isArray(data.result)) return [];
    return data.result;
  } catch (err) {
    process.stderr.write(`[telegram] getUpdates failed: ${(err as Error).message}\n`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
