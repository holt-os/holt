/**
 * `holt mcp`: run Holt as an MCP server so other tools (Claude Code, Cursor,
 * Codex) can recall and remember from this folder's memory.
 *
 * IMPORTANT: in server mode stdout is the JSON-RPC channel. This command must
 * NEVER write to stdout while serving. All startup logging goes to stderr via
 * console.error. Because stdin carries the protocol, we cannot prompt for
 * trust interactively (that would consume protocol bytes), so we auto-trust the
 * launch folder instead.
 *
 * `holt mcp setup` is a normal, non-serving subcommand and may print to stdout.
 */
import { runMcpServer } from '../mcp/server';
import { holtTools } from '../mcp/tools';
import { workspace, isTrusted, trustDir } from '../workspace';

function printSetup(): void {
  const config = JSON.stringify(
    { mcpServers: { holt: { command: 'holt', args: ['mcp'] } } },
    null,
    2,
  );
  const out = [
    'Add Holt as an MCP server to your other tools.',
    '',
    'The server serves the memory of whatever folder it is launched in, and',
    'auto-trusts that folder on first run.',
    '',
    'Claude Code:',
    '  claude mcp add holt -- holt mcp',
    '',
    'Cursor / Codex (JSON config):',
    config,
    '',
  ].join('\n');
  console.log(out);
}

export async function mcp(sub?: string, rest: string[] = []): Promise<void> {
  void rest;
  if (sub === 'setup') {
    printSetup();
    return;
  }

  try {
    // Non-interactive: stdin is the protocol channel, so we cannot prompt.
    // Auto-trust the launch folder instead of calling ensureTrusted/createReader.
    if (!isTrusted()) trustDir();
    console.error('Holt MCP: serving memory for ' + workspace());
    await runMcpServer({ name: 'holt', version: '0.7.0', tools: holtTools() });
  } catch (err) {
    console.error('Holt MCP failed: ' + (err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}
