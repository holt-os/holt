/**
 * MCP contract shared by the protocol engine (server.ts) and the Holt tool set
 * (tools.ts). A tool is a name, a description, a JSON Schema for its arguments,
 * and an async handler that returns text (or throws to signal a tool error).
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // a JSON Schema object
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: McpTool[];
}
