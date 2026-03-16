/**
 * Browser Operator — shared types.
 * Playwright-based runtime (no extension, no WS server).
 */

// ─── Timeout Constants ──────────────────────────────────────────────

export const LAUNCH_TIMEOUT_MS = 15_000;
export const COMMAND_TIMEOUT_MS = 10_000;

// ─── Runtime State ──────────────────────────────────────────────────

export type RuntimeState = 'idle' | 'launching' | 'ready' | 'failed';

// ─── Commands ────────────────────────────────────────────────────────

export type BrowserCommandName =
  | 'ping'
  | 'openTab'
  | 'focusTab'
  | 'closeTab'
  | 'navigate'
  | 'getCurrentUrl'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'pressKey'
  | 'scroll'
  | 'waitFor'
  | 'extractText'
  | 'screenshot'
  | 'dismissCookies'
  | 'status'
  | 'closeBrowser';

export interface BrowserCommand {
  id: string;
  command: BrowserCommandName;
  args?: Record<string, unknown>;
}

export interface BrowserResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BrowserError;
}

export interface BrowserError {
  code: BrowserErrorCode;
  message: string;
  details?: string;
  recoverable: boolean;
  suggestedNextStep?: string;
}

export type BrowserErrorCode =
  | 'element_not_found'
  | 'timeout'
  | 'policy_blocked'
  | 'browser_unavailable'
  | 'unsupported';

// ─── Policy ──────────────────────────────────────────────────────────

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
}

export const DANGEROUS_ACTION_TEXT = [
  'kup teraz', 'buy now', 'place order', 'pay', 'checkout',
  'zamawiam', 'potwierdzam zakup', 'confirm order', 'submit payment',
  'proceed to payment', 'zaplac', 'finalize order',
];

// ─── Status Diagnostics ─────────────────────────────────────────────

export interface RuntimeDiagnostics {
  runtimeState: RuntimeState;
  pageCount: number;
  activeUrl: string | null;
  uptime: number;
}
