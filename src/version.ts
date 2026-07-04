/**
 * Single source of truth for the Holt version. Keep this in sync with the
 * "version" field in package.json on every release (the CI release step and the
 * Homebrew formula bump both key off package.json; this constant is what the CLI
 * and the MCP server report to users and clients).
 */
export const VERSION = '0.8.4';
