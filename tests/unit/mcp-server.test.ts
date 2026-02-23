/**
 * Tests for MCP server — tool registration, request handling, tool bridge.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MCPServer, textResult, errorResult, textMessage } from '../../src/mcp/server.js';
import { MCP_PROTOCOL_VERSION, JSON_RPC_ERRORS } from '../../src/mcp/types.js';
import type { JsonRpcRequest } from '../../src/mcp/types.js';
import { bridgeTools } from '../../src/mcp/tool-bridge.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

describe('MCPServer', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer({ name: 'test-server', version: '1.0.0' });
  });

  it('should handle initialize request', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'test-client', version: '1.0.0' } },
    };

    const response = await server.handleRequest(request);
    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe('test-server');
    expect(result.capabilities.tools).toBeDefined();
  });

  it('should register and list tools', async () => {
    server.registerTool(
      'greet',
      'Say hello',
      { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async (args) => textResult(`Hello, ${args.name}!`),
    );

    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    });

    const result = response.result as any;
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('greet');
    expect(result.tools[0].description).toBe('Say hello');
  });

  it('should call a registered tool', async () => {
    server.registerTool(
      'add',
      'Add two numbers',
      { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      async (args) => textResult(String(Number(args.a) + Number(args.b))),
    );

    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'add', arguments: { a: 2, b: 3 } },
    });

    const result = response.result as any;
    expect(result.content[0].text).toBe('5');
    expect(result.isError).toBeUndefined();
  });

  it('should return error for unknown tool call', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'nonexistent' },
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
  });

  it('should return error for unknown method', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 5, method: 'unknown/method',
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
  });

  it('should handle tool execution errors gracefully', async () => {
    server.registerTool(
      'fail',
      'Always fails',
      { type: 'object' },
      async () => { throw new Error('Intentional failure'); },
    );

    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'fail' },
    });

    const result = response.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Intentional failure');
  });

  it('should register and get prompts', async () => {
    server.registerPrompt(
      'review',
      'Code review prompt',
      [{ name: 'file', required: true }],
      async (args) => [textMessage('user', `Review this file: ${args.file}`)],
    );

    const listResp = await server.handleRequest({
      jsonrpc: '2.0', id: 7, method: 'prompts/list',
    });
    expect((listResp.result as any).prompts).toHaveLength(1);

    const getResp = await server.handleRequest({
      jsonrpc: '2.0', id: 8, method: 'prompts/get',
      params: { name: 'review', arguments: { file: 'main.ts' } },
    });
    const getResult = getResp.result as any;
    expect(getResult.messages[0].content.text).toContain('main.ts');
  });

  it('should track initialization state', async () => {
    expect(server.isInitialized()).toBe(false);

    await server.handleRequest({
      jsonrpc: '2.0', id: 9, method: 'notifications/initialized',
    });

    expect(server.isInitialized()).toBe(true);
  });
});

describe('Tool Bridge', () => {
  it('should bridge Janus tools to MCP server', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
      execute: async (args) => `Contents of ${args.path}`,
    });
    tools.register({
      name: 'exec',
      description: 'Execute command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      execute: async (args) => `Result of: ${args.command}`,
    });

    const server = new MCPServer();
    bridgeTools(server, tools);

    expect(server.getToolCount()).toBe(2);
    expect(server.getToolNames()).toContain('read_file');
    expect(server.getToolNames()).toContain('exec');

    // Call a bridged tool
    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'read_file', arguments: { path: '/test.txt' } },
    });
    const result = response.result as any;
    expect(result.content[0].text).toBe('Contents of /test.txt');
  });
});

describe('Helper functions', () => {
  it('textResult creates correct structure', () => {
    const result = textResult('hello');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as any).text).toBe('hello');
  });

  it('errorResult creates error structure', () => {
    const result = errorResult('something went wrong');
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe('something went wrong');
  });

  it('textMessage creates prompt message', () => {
    const msg = textMessage('user', 'hello');
    expect(msg.role).toBe('user');
    expect((msg.content as any).text).toBe('hello');
  });
});
