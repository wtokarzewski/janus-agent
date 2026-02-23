/**
 * MCP Server — exposes Janus tools via JSON-RPC (Model Context Protocol).
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  MCPServerConfig,
  ServerInfo,
  Capabilities,
  Tool,
  ToolCallResult,
  Prompt,
  PromptMessage,
  TextContent,
  ToolInputSchema,
} from './types.js';
import {
  DEFAULT_SERVER_CONFIG,
  MCP_PROTOCOL_VERSION,
  JSON_RPC_ERRORS,
} from './types.js';

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolCallResult>;
export type PromptHandler = (args: Record<string, string>) => Promise<PromptMessage[]>;

interface RegisteredTool {
  definition: Tool;
  handler: ToolHandler;
}

interface RegisteredPrompt {
  definition: Prompt;
  handler: PromptHandler;
}

export class MCPServer {
  private readonly config: MCPServerConfig;
  private readonly tools: Map<string, RegisteredTool> = new Map();
  private readonly prompts: Map<string, RegisteredPrompt> = new Map();
  private initialized = false;

  constructor(config: Partial<MCPServerConfig> = {}) {
    this.config = {
      ...DEFAULT_SERVER_CONFIG,
      ...config,
      capabilities: {
        ...DEFAULT_SERVER_CONFIG.capabilities,
        ...config.capabilities,
      },
    };
  }

  registerTool(
    name: string,
    description: string,
    inputSchema: ToolInputSchema,
    handler: ToolHandler,
  ): void {
    this.tools.set(name, {
      definition: { name, description, inputSchema },
      handler,
    });
  }

  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  registerPrompt(
    name: string,
    description: string,
    args: Array<{ name: string; description?: string; required?: boolean }>,
    handler: PromptHandler,
  ): void {
    this.prompts.set(name, {
      definition: { name, description, arguments: args },
      handler,
    });
  }

  unregisterPrompt(name: string): boolean {
    return this.prompts.delete(name);
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const result = await this.processRequest(request);
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error) {
      const isKnownError = error instanceof Error &&
        'code' in error &&
        typeof (error as Error & { code: number }).code === 'number';

      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: isKnownError
            ? (error as Error & { code: number }).code
            : JSON_RPC_ERRORS.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async processRequest(request: JsonRpcRequest): Promise<unknown> {
    const { method, params } = request;

    switch (method) {
      case 'initialize':
        return this.handleInitialize();

      case 'notifications/initialized':
        this.initialized = true;
        return {};

      case 'tools/list':
        return this.handleToolsList();

      case 'tools/call':
        return this.handleToolCall(params as { name: string; arguments?: Record<string, unknown> });

      case 'prompts/list':
        return this.handlePromptsList();

      case 'prompts/get':
        return this.handlePromptGet(params as { name: string; arguments?: Record<string, string> });

      default:
        throw Object.assign(
          new Error(`Method not found: ${method}`),
          { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND },
        );
    }
  }

  private handleInitialize(): {
    protocolVersion: string;
    capabilities: Capabilities;
    serverInfo: ServerInfo;
  } {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: this.config.capabilities || {},
      serverInfo: {
        name: this.config.name,
        version: this.config.version,
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    };
  }

  private handleToolsList(): { tools: Tool[] } {
    return {
      tools: Array.from(this.tools.values()).map(t => t.definition),
    };
  }

  private async handleToolCall(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<ToolCallResult> {
    const tool = this.tools.get(params.name);
    if (!tool) {
      throw Object.assign(
        new Error(`Tool not found: ${params.name}`),
        { code: JSON_RPC_ERRORS.INVALID_PARAMS },
      );
    }

    try {
      return await tool.handler(params.arguments || {});
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }

  private handlePromptsList(): { prompts: Prompt[] } {
    return {
      prompts: Array.from(this.prompts.values()).map(p => p.definition),
    };
  }

  private async handlePromptGet(params: {
    name: string;
    arguments?: Record<string, string>;
  }): Promise<{ description?: string; messages: PromptMessage[] }> {
    const prompt = this.prompts.get(params.name);
    if (!prompt) {
      throw Object.assign(
        new Error(`Prompt not found: ${params.name}`),
        { code: JSON_RPC_ERRORS.INVALID_PARAMS },
      );
    }

    const messages = await prompt.handler(params.arguments || {});
    return { description: prompt.definition.description, messages };
  }

  getServerInfo(): ServerInfo {
    return {
      name: this.config.name,
      version: this.config.version,
      protocolVersion: MCP_PROTOCOL_VERSION,
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getToolCount(): number {
    return this.tools.size;
  }

  getPromptCount(): number {
    return this.prompts.size;
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getPromptNames(): string[] {
    return Array.from(this.prompts.keys());
  }
}

export function createMCPServer(config?: Partial<MCPServerConfig>): MCPServer {
  return new MCPServer(config);
}

export function textResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function textMessage(role: 'user' | 'assistant', text: string): PromptMessage {
  return { role, content: { type: 'text', text } as TextContent };
}
