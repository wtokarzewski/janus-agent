/**
 * Bridge Janus ToolRegistry → MCP Server tool registration.
 * Maps each Janus tool to an MCP tool that the editor's LLM can call.
 */

import type { MCPServer } from './server.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolInputSchema } from './types.js';

export function bridgeTools(server: MCPServer, tools: ToolRegistry): void {
  for (const toolDef of tools.list()) {
    const { name, description, parameters } = toolDef.function;

    server.registerTool(
      name,
      description,
      {
        type: 'object',
        properties: (parameters as Record<string, any>).properties ?? {},
        required: (parameters as Record<string, any>).required ?? [],
      } as ToolInputSchema,
      async (args) => {
        const result = await tools.execute(name, args);
        return { content: [{ type: 'text', text: result }] };
      },
    );
  }
}
