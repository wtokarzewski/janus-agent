/**
 * Janus Browser Operator — Background Service Worker (Manifest V3).
 *
 * Responsibilities:
 * - WebSocket client connecting to Janus WS server
 * - Route commands to content scripts
 * - Handle tab-level operations (open, focus, close, navigate)
 * - Manage handshake lifecycle
 */

import type { BrowserCommand, BrowserResponse, ExtensionHello, JanusWelcome } from './types.js';

const JANUS_WS_URL = 'ws://127.0.0.1:19816';
const RECONNECT_INTERVAL_MS = 3000;
const EXTENSION_VERSION = '0.1.0';

let ws: WebSocket | null = null;
let sessionId: string | null = null;
let snapshotConfig = { viewportOnly: true, maxElements: 100, maxGroups: 25 };
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    sessionId = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_INTERVAL_MS);
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
    extensionVersion: EXTENSION_VERSION,
    profileId: 'janus-browser',
    activeTab: activeTab ? {
      tabId: activeTab.id!,
      url: activeTab.url ?? '',
      title: activeTab.title ?? '',
    } : undefined,
    capabilities: {
      snapshot: true,
      click: true,
      type: true,
      pressKey: true,
      scroll: true,
      screenshot: true,
    },
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
    snapshotConfig = welcome.snapshotConfig;
    console.log(`[Janus] Session: ${sessionId}, policy: ${welcome.policyMode}`);
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

connect();

// Reconnect on extension wake (service worker can be suspended)
chrome.runtime.onStartup.addListener(() => {
  connect();
});
