/**
 * Direct API brains: talk to a provider over HTTP with your own key, streaming
 * the reply via Server-Sent Events. Zero dependencies (global fetch only).
 */
import type { ApiBrain } from './config';
import { resolveApiKey, keyHint, PROVIDER_ENV } from './config';

export interface ApiResult {
  ok: boolean;
  text: string;
}

/**
 * Pure SSE line splitter. Feed it whatever bytes you have decoded so far; it
 * returns complete event blocks (split on the blank-line delimiter) plus any
 * trailing partial block to carry into the next call. Network-free, so it can
 * be unit-tested directly.
 */
export function parseSSELines(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  const events = parts.filter((p) => p.trim() !== '');
  return { events, rest };
}

/** Collect the "data:" payloads from one SSE event block. */
function dataLines(event: string): string[] {
  const out: string[] = [];
  for (const line of event.split('\n')) {
    const t = line.replace(/\r$/, '');
    if (t.startsWith('data:')) out.push(t.slice(5).replace(/^ /, ''));
  }
  return out;
}

/** Pull the delta text out of a single provider JSON payload. */
function extractDelta(provider: ApiBrain['provider'], json: unknown): string {
  const j = json as Record<string, unknown>;
  if (provider === 'anthropic') {
    if (j['type'] === 'content_block_delta') {
      const delta = j['delta'] as { type?: string; text?: string } | undefined;
      if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') return delta.text;
    }
    return '';
  }
  if (provider === 'openai') {
    const choices = j['choices'] as Array<{ delta?: { content?: string } }> | undefined;
    const content = choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  }
  // gemini
  const candidates = j['candidates'] as
    | Array<{ content?: { parts?: Array<{ text?: string }> } }>
    | undefined;
  const parts = candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
}

interface RequestSpec {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function buildRequest(brain: ApiBrain, key: string, prompt: string): RequestSpec {
  if (brain.provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: brain.model,
        max_tokens: 4096,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    };
  }
  if (brain.provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: brain.model,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    };
  }
  // gemini
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(brain.model)}:streamGenerateContent?alt=sse`,
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  };
}

/**
 * Run one turn against an API brain. Streams delta text through onChunk as it
 * arrives and resolves with the full reply. Never throws: failures come back as
 * { ok: false, text }.
 */
export async function runApiBrain(
  brain: ApiBrain,
  prompt: string,
  onChunk?: (chunk: string) => void,
): Promise<ApiResult> {
  const key = resolveApiKey(brain);
  if (!key) {
    return {
      ok: false,
      text: `No API key for "${brain.id}" (${brain.provider}). Fix: ${keyHint(brain)}. Standard env var: ${PROVIDER_ENV[brain.provider]}.`,
    };
  }

  const spec = buildRequest(brain, key, prompt);
  let res: Response;
  try {
    res = await fetch(spec.url, { method: 'POST', headers: spec.headers, body: spec.body });
  } catch (e) {
    return { ok: false, text: `Could not reach ${brain.provider}: ${(e as Error).message}` };
  }

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    return { ok: false, text: `${brain.provider} error ${res.status}: ${body.slice(0, 200)}` };
  }

  if (!res.body) {
    // No stream (unexpected); fall back to reading the whole body once.
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    return { ok: false, text: `${brain.provider} returned no stream. Body: ${body.slice(0, 200)}` };
  }

  const decoder = new TextDecoder();
  let carry = '';
  let text = '';
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      carry += decoder.decode(chunk, { stream: true });
      const { events, rest } = parseSSELines(carry);
      carry = rest;
      for (const ev of events) {
        for (const payload of dataLines(ev)) {
          if (payload === '[DONE]') continue;
          let json: unknown;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // non-JSON keepalive or comment
          }
          const piece = extractDelta(brain.provider, json);
          if (piece) {
            text += piece;
            if (onChunk) onChunk(piece);
          }
        }
      }
    }
  } catch (e) {
    if (text) return { ok: true, text };
    return { ok: false, text: `Stream from ${brain.provider} failed: ${(e as Error).message}` };
  }

  // Flush any trailing buffered event.
  if (carry.trim()) {
    for (const payload of dataLines(carry)) {
      if (payload === '[DONE]') continue;
      try {
        const piece = extractDelta(brain.provider, JSON.parse(payload));
        if (piece) {
          text += piece;
          if (onChunk) onChunk(piece);
        }
      } catch {
        // ignore trailing partials
      }
    }
  }

  const trimmed = text.trim();
  if (trimmed) return { ok: true, text: trimmed };
  return { ok: false, text: `${brain.provider} returned an empty reply.` };
}
