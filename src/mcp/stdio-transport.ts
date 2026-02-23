/**
 * MCP Stdio Transport — JSONL over stdin/stdout.
 * Standard MCP transport for editor integrations (Claude Code, Cursor, VS Code).
 */

import { createInterface } from 'node:readline';
import type { MCPServer } from './server.js';
import { JSON_RPC_ERRORS } from './types.js';

export async function runStdioServer(server: MCPServer): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line);
      const response = await server.handleRequest(request);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERRORS.PARSE_ERROR, message: 'Parse error' },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  }
}
