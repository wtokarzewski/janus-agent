/**
 * MCP (Model Context Protocol) types
 *
 * Based on the MCP specification for connecting AI models to external tools.
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface ServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
}

export interface ClientInfo {
  name: string;
  version: string;
}

export interface Capabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  logging?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, ToolProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: ToolProperty;
}

export interface ToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolCallResult {
  content: ToolContent[];
  isError?: boolean;
}

export type ToolContent =
  | TextContent
  | ImageContent
  | ResourceContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export interface Prompt {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: TextContent | ImageContent | ResourceContent;
}

export interface MCPServerConfig {
  name: string;
  version: string;
  capabilities?: Capabilities;
}

export const DEFAULT_SERVER_CONFIG: MCPServerConfig = {
  name: 'janus-mcp-server',
  version: '0.1.0',
  capabilities: {
    tools: { listChanged: true },
    prompts: { listChanged: true },
  },
};
