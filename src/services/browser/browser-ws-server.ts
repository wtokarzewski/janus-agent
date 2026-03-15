/**
 * Browser Operator — WebSocket server for extension communication.
 * Janus owns the WS server. Extension connects as client.
 * Lazy-started on first browser tool call.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import * as log from '../../utils/logger.js';
import type {
  BrowserCommand, BrowserResponse, ExtensionHello, JanusWelcome,
  SnapshotConfig,
} from './browser-types.js';
import { BROWSER_WS_PORT, DEFAULT_SNAPSHOT_CONFIG } from './browser-types.js';

export class BrowserWsServer {
  private wss: WebSocketServer | null = null;
  private extensionSocket: WebSocket | null = null;
  private sessionId: string | null = null;
  private pendingRequests = new Map<string, {
    resolve: (response: BrowserResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readyResolvers: Array<() => void> = [];
  private _ready = false;
  private snapshotConfig: SnapshotConfig = DEFAULT_SNAPSHOT_CONFIG;

  get ready(): boolean {
    return this._ready && this.extensionSocket?.readyState === WebSocket.OPEN;
  }

  /** Start WebSocket server. Idempotent — does nothing if already running. */
  start(): void {
    if (this.wss) return;

    this.wss = new WebSocketServer({ port: BROWSER_WS_PORT, host: '127.0.0.1' });
    log.info(`Browser WS server listening on ws://127.0.0.1:${BROWSER_WS_PORT}`);

    this.wss.on('connection', (ws) => {
      log.info('Browser extension connected');
      this.extensionSocket = ws;

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg, ws);
        } catch (err) {
          log.warn(`Browser WS: invalid message: ${err instanceof Error ? err.message : err}`);
        }
      });

      ws.on('close', () => {
        log.info('Browser extension disconnected');
        if (this.extensionSocket === ws) {
          this.extensionSocket = null;
          this._ready = false;
        }
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error('Extension disconnected'));
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);
        }
      });

      ws.on('error', (err) => {
        log.error(`Browser WS error: ${err.message}`);
      });
    });

    this.wss.on('error', (err) => {
      log.error(`Browser WS server error: ${err.message}`);
    });
  }

  /** Wait until extension is connected and handshake complete. */
  waitForReady(timeoutMs = 30_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.readyResolvers.push(resolve);
      const timer = setTimeout(() => {
        this.readyResolvers = this.readyResolvers.filter(r => r !== resolve);
        reject(new Error(`Browser extension did not connect within ${timeoutMs}ms`));
      }, timeoutMs);
      // Clean up timer if resolved
      const origResolve = resolve;
      this.readyResolvers[this.readyResolvers.length - 1] = () => {
        clearTimeout(timer);
        origResolve();
      };
    });
  }

  /** Send a command to the extension and wait for response. */
  async send(command: BrowserCommand, timeoutMs = 15_000): Promise<BrowserResponse> {
    if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
      return {
        id: command.id,
        ok: false,
        error: {
          code: 'extension_unavailable',
          message: 'Browser extension is not connected',
          recoverable: true,
          suggestedNextStep: 'Wait for extension to connect or restart browser',
        },
      };
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(command.id);
        resolve({
          id: command.id,
          ok: false,
          error: {
            code: 'timeout',
            message: `Command ${command.command} timed out after ${timeoutMs}ms`,
            recoverable: true,
            suggestedNextStep: 'Try again or take a screenshot to debug',
          },
        });
      }, timeoutMs);

      this.pendingRequests.set(command.id, { resolve, reject, timer });
      this.extensionSocket!.send(JSON.stringify(command));
    });
  }

  /** Stop the WS server and clean up. */
  stop(): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Server stopping'));
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
    this.extensionSocket?.close();
    this.wss?.close();
    this.wss = null;
    this.extensionSocket = null;
    this._ready = false;
    log.info('Browser WS server stopped');
  }

  private handleMessage(msg: Record<string, unknown>, ws: WebSocket): void {
    // Handshake: extension hello
    if (msg.type === 'hello') {
      const hello = msg as unknown as ExtensionHello;
      this.sessionId = randomUUID();
      log.info(`Browser handshake: extension v${hello.extensionVersion}, browser ${hello.browser?.name} ${hello.browser?.version}`);

      const welcome: JanusWelcome = {
        type: 'welcome',
        sessionId: this.sessionId,
        ready: true,
        policyMode: 'read_only',
        snapshotConfig: this.snapshotConfig,
      };
      ws.send(JSON.stringify(welcome));

      this._ready = true;
      for (const resolve of this.readyResolvers) resolve();
      this.readyResolvers = [];
      return;
    }

    // Command response from extension
    if (msg.id && typeof msg.id === 'string') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg as unknown as BrowserResponse);
      }
      return;
    }

    log.debug(`Browser WS: unhandled message type: ${JSON.stringify(msg).slice(0, 200)}`);
  }
}
