/**
 * Shared types for Chrome Extension (mirrors Janus browser-types).
 * Kept separate to avoid importing Node.js modules in extension context.
 */

export interface BrowserCommand {
  id: string;
  command: string;
  tabId?: number;
  args?: Record<string, unknown>;
}

export interface BrowserResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    suggestedNextStep?: string;
  };
}

export interface ExtensionHello {
  type: 'hello';
  extensionVersion: string;
  profileId: string;
  activeTab?: { tabId: number; url: string; title: string };
  capabilities: {
    snapshot: boolean;
    click: boolean;
    type: boolean;
    pressKey: boolean;
    scroll: boolean;
    screenshot: boolean;
  };
  browser: {
    name: string;
    version: string;
    userAgent: string;
  };
}

export interface JanusWelcome {
  type: 'welcome';
  sessionId: string;
  ready: boolean;
  policyMode: string;
  snapshotConfig: {
    viewportOnly: boolean;
    maxElements: number;
    maxGroups: number;
  };
}
