/**
 * MCP Stdio Transport — JSONL over stdin/stdout.
 * Standard MCP transport for editor integrations (Claude Code, Cursor, VS Code).
 */

import { createInterface } from 'node:readline';
import type { MCPServer } from './server.js';
import { JSON_RPC_ERRORS } from './types.js';

/** Maximum size of a single JSON-RPC message (1 MB). Prevents DoS via oversized payloads. */
const MAX_MESSAGE_BYTES = 1_048_576;

export async function runStdioServer(server: MCPServer): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;

    if (Buffer.byteLength(line, 'utf-8') > MAX_MESSAGE_BYTES) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: `Message too large (max ${MAX_MESSAGE_BYTES} bytes)` },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
      continue;
    }

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
