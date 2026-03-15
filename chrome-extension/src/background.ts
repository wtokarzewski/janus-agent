/**
 * Janus Browser Operator — Background Service Worker (Manifest V3).
 *
 * Responsibilities:
 * - WebSocket client connecting to Janus WS server
 * - Route commands to content scripts
 * - Handle tab-level operations (open, focus, close, navigate)
 * - Manage handshake lifecycle
 * - Exponential backoff reconnection with jitter
 * - Session persistence via chrome.storage.session
 */

import type { BrowserCommand, BrowserResponse, ExtensionHello, JanusWelcome } from './types.js';

const JANUS_WS_URL = 'ws://127.0.0.1:19816';
const EXTENSION_VERSION = '0.1.0';
const PROTOCOL_VERSION = 1;

// ─── Exponential Backoff Config ──────────────────────────────────────

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MULTIPLIER = 2;
const RECONNECT_CAP_MS = 30_000;
const RECONNECT_JITTER = 0.15; // +/-15%

let ws: WebSocket | null = null;
let sessionId: string | null = null;
let policyMode: string | null = null;
let snapshotConfig = { viewportOnly: true, maxElements: 100, maxGroups: 25 };
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let lastHandshakeAt: number | null = null;

// ─── Session Persistence ────────────────────────────────────────────

interface PersistedState {
  sessionId: string | null;
  connectionState: 'connected' | 'disconnected';
  policyMode: string | null;
  lastHandshakeAt: number | null;
  protocolVersion: number | null;
  enabledCapabilities: string[];
}

let acceptedProtocolVersion: number | null = null;
let enabledCapabilities: string[] = [];

async function persistState(): Promise<void> {
  try {
    const state: PersistedState = {
      sessionId,
      connectionState: ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      policyMode,
      lastHandshakeAt,
      protocolVersion: acceptedProtocolVersion,
      enabledCapabilities,
    };
    await chrome.storage.session.set({ janusState: state });
  } catch {
    // storage.session may not be available in all contexts
  }
}

async function restoreState(): Promise<PersistedState | null> {
  try {
    const result = await chrome.storage.session.get('janusState');
    return (result.janusState as PersistedState) ?? null;
  } catch {
    return null;
  }
}

// ─── WebSocket Connection ────────────────────────────────────────────

function connect(): void {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(JANUS_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
    console.log('[Janus] Connected to WS server');
    reconnectAttempt = 0; // Reset backoff on successful connection
    await sendHello();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      handleMessage(msg);
    } catch (err) {
      console.warn('[Janus] Invalid message:', err);
    }
  };

  ws.onclose = () => {
    console.log('[Janus] Disconnected from WS server');
    ws = null;
    persistState();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  // Exponential backoff: base * multiplier^attempt, capped
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, reconnectAttempt),
    RECONNECT_CAP_MS,
  );

  // Apply jitter: +/-15%
  const jitter = delay * RECONNECT_JITTER * (2 * Math.random() - 1);
  const finalDelay = Math.round(delay + jitter);

  reconnectAttempt++;
  console.log(`[Janus] Reconnecting in ${finalDelay}ms (attempt ${reconnectAttempt})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, finalDelay);
}

function send(data: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Handshake ───────────────────────────────────────────────────────

async function sendHello(): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const hello: ExtensionHello = {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: EXTENSION_VERSION,
    profileId: 'janus-browser',
    activeTab: activeTab ? {
      tabId: activeTab.id!,
      url: activeTab.url ?? '',
      title: activeTab.title ?? '',
    } : undefined,
    capabilities: ['snapshot', 'click', 'type', 'pressKey', 'scroll', 'screenshot'],
    browser: {
      name: 'chrome',
      version: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown',
      userAgent: navigator.userAgent,
    },
  };
  send(hello);
}

// ─── Message Handling ────────────────────────────────────────────────

function handleMessage(msg: Record<string, unknown>): void {
  // Welcome response from Janus
  if (msg.type === 'welcome') {
    const welcome = msg as unknown as JanusWelcome;
    sessionId = welcome.sessionId;
    policyMode = welcome.policyMode;
    snapshotConfig = welcome.snapshotConfig;
    acceptedProtocolVersion = welcome.acceptedProtocolVersion;
    enabledCapabilities = welcome.enabledCapabilities ?? [];
    lastHandshakeAt = Date.now();
    console.log(`[Janus] Session: ${sessionId}, policy: ${welcome.policyMode}, protocol: v${welcome.acceptedProtocolVersion}, capabilities: ${enabledCapabilities.join(', ')}`);
    persistState();
    return;
  }

  // Command from Janus
  if (msg.id && msg.command) {
    handleCommand(msg as unknown as BrowserCommand);
    return;
  }
}

async function handleCommand(cmd: BrowserCommand): Promise<void> {
  try {
    const result = await executeCommand(cmd);
    send(result);
  } catch (err) {
    const response: BrowserResponse = {
      id: cmd.id,
      ok: false,
      error: {
        code: 'extension_error',
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      },
    };
    send(response);
  }
}

async function executeCommand(cmd: BrowserCommand): Promise<BrowserResponse> {
  switch (cmd.command) {
    case 'ping':
      return { id: cmd.id, ok: true, result: { pong: true, timestamp: Date.now() } };

    case 'getCurrentUrl': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { id: cmd.id, ok: true, result: { url: tab?.url, title: tab?.title, tabId: tab?.id } };
    }

    case 'openTab': {
      const url = String(cmd.args?.url ?? 'about:blank');
      const tab = await chrome.tabs.create({ url });
      return { id: cmd.id, ok: true, result: { tabId: tab.id, url: tab.url } };
    }

    case 'focusTab': {
      const tabId = Number(cmd.args?.tabId ?? cmd.tabId);
      if (tabId) await chrome.tabs.update(tabId, { active: true });
      return { id: cmd.id, ok: true, result: { focused: tabId } };
    }

    case 'closeTab': {
      const tabId = Number(cmd.args?.tabId ?? cmd.tabId);
      if (tabId) await chrome.tabs.remove(tabId);
      return { id: cmd.id, ok: true, result: { closed: tabId } };
    }

    case 'navigate': {
      const url = String(cmd.args?.url ?? '');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.update(tab.id, { url });
      return { id: cmd.id, ok: true, result: { navigated: url, tabId: tab?.id } };
    }

    case 'screenshot': {
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
      return { id: cmd.id, ok: true, result: { screenshot: dataUrl } };
    }

    // Content script commands — forward to active tab
    case 'snapshot':
    case 'click':
    case 'type':
    case 'pressKey':
    case 'scroll':
    case 'waitFor':
    case 'extractText': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        return { id: cmd.id, ok: false, error: { code: 'tab_not_found', message: 'No active tab', recoverable: true } };
      }
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'command',
        ...cmd,
        snapshotConfig,
      });
      return { ...response, id: cmd.id };
    }

    default:
      return { id: cmd.id, ok: false, error: { code: 'unsupported', message: `Unknown command: ${cmd.command}`, recoverable: false } };
  }
}

// ─── Start ───────────────────────────────────────────────────────────

// On service worker startup, try to restore persisted state before reconnecting
(async () => {
  const persisted = await restoreState();
  if (persisted) {
    sessionId = persisted.sessionId;
    policyMode = persisted.policyMode;
    lastHandshakeAt = persisted.lastHandshakeAt;
    console.log(`[Janus] Restored session state: ${sessionId}, policy: ${policyMode}`);
  }
  connect();
})();

// Reconnect on extension wake (service worker can be suspended)
chrome.runtime.onStartup.addListener(() => {
  connect();
});
