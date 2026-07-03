/**
 * A from-scratch JSON-RPC 2.0 MCP server over stdio with ZERO runtime
 * dependencies. It reads newline-delimited JSON-RPC messages from stdin,
 * dispatches MCP methods, and writes compact JSON responses to stdout.
 *
 * CRITICAL: stdout carries ONLY JSON-RPC messages, one compact JSON object per
 * line. All logging goes to stderr (console.error). A single stray stdout write
 * corrupts the protocol.
 */
import type { McpServerOptions } from './types';

/** The MCP protocol version we default to when the client does not send one. */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** A minimal shape for a JSON-RPC request/notification after parsing. */
interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** True when the value is a plain object (not null, not an array). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Build a JSON-RPC success response object. */
function ok(id: unknown, result: unknown): object {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** Build a JSON-RPC error response object. */
function err(id: unknown, code: number, message: string): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Pure dispatcher: takes one parsed JSON-RPC message and returns the response
 * object to send, or null for notifications (no response). Never throws; on any
 * internal failure for a request it returns a JSON-RPC error object.
 */
export async function handleMcpMessage(
  msg: unknown,
  opts: McpServerOptions,
): Promise<object | null> {
  // Non-object messages (including arrays) cannot be dispatched as a single
  // request. We have no id to echo, so we cannot form a valid error response.
  if (!isObject(msg)) {
    console.error('[mcp] ignoring non-object message');
    return null;
  }

  const message = msg as JsonRpcMessage;
  const method = typeof message.method === 'string' ? message.method : undefined;
  const hasId = 'id' in message && message.id !== undefined && message.id !== null;
  const id = message.id;

  // A message with no method string is not something we can act on.
  if (method === undefined) {
    if (hasId) return err(id, -32600, 'Invalid Request: missing method');
    console.error('[mcp] ignoring message with no method');
    return null;
  }

  // Notifications (no id). Process side effects (none needed here) and stay
  // silent. This covers notifications/initialized and any other notifications/*.
  if (!hasId) {
    if (!method.startsWith('notifications/')) {
      console.error(`[mcp] ignoring notification-shaped message: ${method}`);
    }
    return null;
  }

  const params = isObject(message.params) ? message.params : {};

  try {
    switch (method) {
      case 'initialize': {
        const requested = params['protocolVersion'];
        const protocolVersion =
          typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION;
        return ok(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: opts.name, version: opts.version },
        });
      }

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, {
          tools: opts.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case 'tools/call': {
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const rawArgs = params['arguments'];
        const args = isObject(rawArgs) ? rawArgs : {};
        const tool = opts.tools.find((t) => t.name === name);
        if (!tool) {
          return ok(id, {
            content: [{ type: 'text', text: 'Unknown tool: ' + name }],
            isError: true,
          });
        }
        try {
          const text = await tool.handler(args);
          return ok(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          const emsg = e instanceof Error ? e.message : String(e);
          return ok(id, {
            content: [{ type: 'text', text: 'Tool error: ' + emsg }],
            isError: true,
          });
        }
      }

      default:
        return err(id, -32601, 'Method not found: ' + method);
    }
  } catch (e) {
    // Defensive: any unexpected failure becomes an internal-error response so a
    // request never goes unanswered and we never throw out of the dispatcher.
    const emsg = e instanceof Error ? e.message : String(e);
    console.error(`[mcp] internal error handling ${method}: ${emsg}`);
    return err(id, -32603, 'Internal error: ' + emsg);
  }
}

/**
 * Attempt to recover a JSON-RPC id from a line that failed to JSON.parse, so we
 * can send a proper parse-error response instead of silently dropping it. Best
 * effort only: matches a top-level "id" whose value is a number or string.
 */
function recoverId(line: string): number | string | null {
  const num = line.match(/"id"\s*:\s*(-?\d+(?:\.\d+)?)/);
  if (num && num[1] !== undefined) {
    const n = Number(num[1]);
    if (Number.isFinite(n)) return n;
  }
  const str = line.match(/"id"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (str && str[1] !== undefined) return str[1];
  return null;
}

/**
 * Thin stdin/stdout loop. Buffers stdin chunks, splits on newlines, parses each
 * complete line, dispatches via handleMcpMessage, and writes any non-null
 * response as a single compact JSON line to stdout. Resolves on stdin end.
 */
export function runMcpServer(opts: McpServerOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const stdin = process.stdin;
    let buffer = '';
    // Serialize async handling so responses are written in request order.
    let chain: Promise<void> = Promise.resolve();

    const send = (response: object): void => {
      // One compact JSON object per line. JSON.stringify never emits raw
      // newlines, so the object is guaranteed to be a single line.
      process.stdout.write(JSON.stringify(response) + '\n');
    };

    const processLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (line === '') return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        const id = recoverId(line);
        if (id !== null) {
          send(err(id, -32700, 'Parse error'));
        } else {
          console.error('[mcp] parse error on line, no id to recover, skipping');
        }
        return;
      }

      // Optional batch support: an array of messages. Map over entries and
      // emit each non-null response as its own line (per JSON-RPC we may reply
      // to a batch with individual results; single-message handling is primary).
      if (Array.isArray(parsed)) {
        chain = chain.then(async () => {
          for (const entry of parsed) {
            const response = await handleMcpMessage(entry, opts);
            if (response !== null) send(response);
          }
        });
        return;
      }

      chain = chain.then(async () => {
        const response = await handleMcpMessage(parsed, opts);
        if (response !== null) send(response);
      });
    };

    stdin.setEncoding('utf8');

    stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line);
        nl = buffer.indexOf('\n');
      }
    });

    stdin.on('end', () => {
      // Flush any trailing line without a terminating newline.
      if (buffer.length > 0) {
        processLine(buffer);
        buffer = '';
      }
      // Wait for the async chain to drain, then resolve cleanly.
      chain.then(() => resolve()).catch(() => resolve());
    });

    stdin.on('error', (e: Error) => {
      console.error(`[mcp] stdin error: ${e.message}`);
      chain.then(() => resolve()).catch(() => resolve());
    });

    // Kick the stream in case it is paused.
    stdin.resume();
  });
}
