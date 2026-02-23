/**
 * MCP Server command — exposes Janus tools via stdin/stdout JSON-RPC.
 * Usage: npm start -- mcp-server
 *
 * Configure in editor (e.g. Claude Code mcp.json):
 * { "janus": { "command": "npm", "args": ["start", "--", "mcp-server"], "cwd": "/path/to/workspace" } }
 */

import { loadConfig } from '../config/config.js';
import { createApp } from '../bootstrap.js';
import { MCPServer } from '../mcp/server.js';
import { bridgeTools } from '../mcp/tool-bridge.js';
import { runStdioServer } from '../mcp/stdio-transport.js';

export async function startMcpServer(): Promise<void> {
  // Redirect logs to stderr (stdout is reserved for MCP protocol)
  const originalLog = console.log;
  console.log = console.error;

  const config = await loadConfig();
  const app = await createApp(config);

  const server = new MCPServer({
    name: 'janus',
    version: '0.1.0',
    capabilities: { tools: { listChanged: true } },
  });

  bridgeTools(server, app.tools);

  console.error(`Janus MCP server started with ${server.getToolCount()} tools: ${server.getToolNames().join(', ')}`);

  await runStdioServer(server);

  // Restore console.log on exit
  console.log = originalLog;
}
