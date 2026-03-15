/**
 * Browser Operator — WebSocket server for extension communication.
 * Janus owns the WS server. Extension connects as client.
 * Lazy-started on first browser tool call.
 *
 * State machine:
 *   idle → starting_ws → waiting_for_extension → ready
 *   ready → disconnected_temporarily → ready (reconnect within grace period)
 *   ready → disconnected_temporarily → failed (grace period expired)
 *   any → failed (on unrecoverable error)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import * as log from '../../utils/logger.js';
import type {
  BrowserCommand, BrowserResponse, ExtensionHello, JanusWelcome,
  SnapshotConfig, RuntimeState, TabState, RuntimeDiagnostics,
} from './browser-types.js';
import {
  BROWSER_WS_PORT, DEFAULT_SNAPSHOT_CONFIG, COMMAND_TIMEOUT_MS,
  RECONNECT_GRACE_MS, protocolVersion,
} from './browser-types.js';

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
  private _runtimeState: RuntimeState = 'idle';
  private snapshotConfig: SnapshotConfig = DEFAULT_SNAPSHOT_CONFIG;
  private tabs = new Map<number, TabState>();
  private lastHandshakeAt: number | null = null;
  private reconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt: number | null = null;

  get runtimeState(): RuntimeState {
    return this._runtimeState;
  }

  get ready(): boolean {
    return this._runtimeState === 'ready' && this.extensionSocket?.readyState === WebSocket.OPEN;
  }

  /** Transition the runtime state machine. */
  private transitionTo(next: RuntimeState): void {
    const prev = this._runtimeState;
    if (prev === next) return;
    log.info(`Browser state: ${prev} -> ${next}`);
    this._runtimeState = next;
  }

  /** Start WebSocket server. Idempotent — does nothing if already running. */
  start(): void {
    if (this.wss) return;
    // Recover from previous failed state (e.g. EADDRINUSE that was resolved)
    if (this._runtimeState === 'failed') {
      this.transitionTo('idle');
    }

    this.transitionTo('starting_ws');
    this.startedAt = Date.now();

    this.wss = new WebSocketServer({ port: BROWSER_WS_PORT, host: '127.0.0.1' });
    log.info(`Browser WS server listening on ws://127.0.0.1:${BROWSER_WS_PORT}`);

    this.transitionTo('waiting_for_extension');

    this.setupConnectionHandler();

    this.wss.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.warn(`Browser WS port ${BROWSER_WS_PORT} already in use — previous server still running`);
        // Clean up failed instance so retry can work
        this.wss?.close();
        this.wss = null;
        this.transitionTo('idle');
      } else {
        log.error(`Browser WS server error: ${err.message}`);
        this.transitionTo('failed');
      }
    });
  }

  private setupConnectionHandler(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws) => {
      log.info('Browser extension connected');

      // Clear any reconnect grace timer
      if (this.reconnectGraceTimer) {
        clearTimeout(this.reconnectGraceTimer);
        this.reconnectGraceTimer = null;
      }

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
          this.handleDisconnect();
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
  }

  /** Handle extension disconnect with grace period for reconnection. */
  private handleDisconnect(): void {
    if (this._runtimeState === 'ready') {
      this.transitionTo('disconnected_temporarily');

      this.reconnectGraceTimer = setTimeout(() => {
        this.reconnectGraceTimer = null;
        if (this._runtimeState === 'disconnected_temporarily') {
          log.warn(`Browser extension did not reconnect within ${RECONNECT_GRACE_MS}ms grace period`);
          this.transitionTo('failed');
        }
      }, RECONNECT_GRACE_MS);
    }
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
  async send(command: BrowserCommand, timeoutMs = COMMAND_TIMEOUT_MS): Promise<BrowserResponse> {
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

    return new Promise((resolve, _reject) => {
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

      this.pendingRequests.set(command.id, { resolve, reject: _reject, timer });
      this.extensionSocket!.send(JSON.stringify(command));
    });
  }

  /** Get runtime diagnostics for status reporting. */
  getStatus(): RuntimeDiagnostics {
    return {
      runtimeState: this._runtimeState,
      wsServerRunning: this.wss !== null,
      extensionConnected: this.extensionSocket?.readyState === WebSocket.OPEN,
      sessionId: this.sessionId,
      activeTabCount: [...this.tabs.values()].filter(t => t.status !== 'closed' && t.status !== 'stale').length,
      lastHandshakeAt: this.lastHandshakeAt,
      protocolVersion,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /** Stop the WS server and clean up. */
  stop(): void {
    if (this.reconnectGraceTimer) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
    }
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Server stopping'));
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
    this.extensionSocket?.close();
    this.wss?.close();
    this.wss = null;
    this.extensionSocket = null;
    this.tabs.clear();
    this.transitionTo('idle');
    this.startedAt = null;
    this.lastHandshakeAt = null;
    this.sessionId = null;
    log.info('Browser WS server stopped');
  }

  private handleMessage(msg: Record<string, unknown>, ws: WebSocket): void {
    // Handshake: extension hello
    if (msg.type === 'hello') {
      const hello = msg as unknown as ExtensionHello;
      this.sessionId = randomUUID();
      this.lastHandshakeAt = Date.now();

      const helloVersion = hello.protocolVersion ?? 1;
      const helloCaps = Array.isArray(hello.capabilities) ? hello.capabilities : [];

      log.info(`Browser handshake: extension v${hello.extensionVersion}, protocol v${helloVersion}, browser ${hello.browser?.name} ${hello.browser?.version}`);
      log.info(`Browser capabilities: ${helloCaps.join(', ')}`);

      // Store active tab if provided
      if (hello.activeTab) {
        const tab: TabState = {
          tabId: hello.activeTab.tabId,
          url: hello.activeTab.url,
          title: hello.activeTab.title,
          active: true,
          controlled: false,
          status: 'discovered',
          lastSeenAt: Date.now(),
          snapshotVersion: 0,
        };
        this.tabs.set(tab.tabId, tab);
      }

      const welcome: JanusWelcome = {
        type: 'welcome',
        sessionId: this.sessionId,
        acceptedProtocolVersion: Math.min(helloVersion, protocolVersion),
        ready: true,
        policyMode: 'read_only',
        enabledCapabilities: helloCaps,
        snapshotConfig: this.snapshotConfig,
      };
      ws.send(JSON.stringify(welcome));

      this.transitionTo('ready');
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
