/**
 * MCP Client — connects to external MCP servers via stdio transport.
 * Spawns child process, communicates via JSON-RPC over stdin/stdout.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { JsonRpcRequest, JsonRpcResponse, Tool as MCPTool } from './types.js';
import { MCP_PROTOCOL_VERSION } from './types.js';
import type { Tool } from '../tools/types.js';
import * as log from '../utils/logger.js';

export interface MCPServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class MCPClient {
  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private spec: MCPServerSpec;

  constructor(spec: MCPServerSpec) {
    this.spec = spec;
  }

  async connect(): Promise<void> {
    this.proc = spawn(this.spec.command, this.spec.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.spec.env },
    });

    this.proc.on('error', (err) => {
      log.error(`MCP client "${this.spec.name}" process error: ${err.message}`);
    });

    this.proc.on('exit', (code) => {
      log.info(`MCP client "${this.spec.name}" exited (code=${code})`);
      // Reject all pending requests
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP server "${this.spec.name}" exited`));
      }
      this.pending.clear();
      this.proc = null;
    });

    // Read JSON-RPC responses line-by-line from stdout
    if (this.proc.stdout) {
      const rl = createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (msg.id != null) {
            const handler = this.pending.get(Number(msg.id));
            if (handler) {
              this.pending.delete(Number(msg.id));
              if (msg.error) {
                handler.reject(new Error(msg.error.message));
              } else {
                handler.resolve(msg.result);
              }
            }
          }
        } catch {
          // Not JSON — ignore (could be logging from server)
        }
      });
    }

    // stderr → log
    if (this.proc.stderr) {
      const rl = createInterface({ input: this.proc.stderr });
      rl.on('line', (line) => {
        log.debug(`MCP[${this.spec.name}] stderr: ${line}`);
      });
    }

    // Initialize handshake
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'janus', version: '1.0.0' },
    });

    await this.notify('notifications/initialized');
    log.info(`MCP client "${this.spec.name}" connected`);
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request('tools/list') as { tools: MCPTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args }) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    const texts = (result.content ?? [])
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!);

    const output = texts.join('\n') || '(no output)';
    return result.isError ? `Error: ${output}` : output;
  }

  async disconnect(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error(`MCP server "${this.spec.name}" not connected`));
        return;
      }

      const id = ++this.requestId;
      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

      this.pending.set(id, { resolve, reject });

      // Timeout after 30s
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request "${method}" timed out`));
        }
      }, 30_000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    const msg = { jsonrpc: '2.0', method, params };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }
}

/**
 * Creates a Janus Tool that proxies to a remote MCP server tool.
 */
export function createMCPProxyTool(client: MCPClient, serverName: string, mcpTool: MCPTool): Tool {
  return {
    name: `mcp_${serverName}_${mcpTool.name}`,
    description: `[MCP:${serverName}] ${mcpTool.description}`,
    parameters: mcpTool.inputSchema as unknown as Record<string, unknown>,
    async execute(args: Record<string, unknown>): Promise<string> {
      return client.callTool(mcpTool.name, args);
    },
  };
}
