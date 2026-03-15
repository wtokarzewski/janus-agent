/**
 * Browser Operator — shared types for Janus <-> Chrome Extension protocol.
 *
 * Frozen baseline v1:
 * - Janus = WS server on ws://127.0.0.1:19816
 * - Extension = WS client
 * - Single tool: browser({ command, args })
 * - Snapshot: viewportOnly, maxElements=100, maxGroups=25
 */

// ─── Protocol Version ────────────────────────────────────────────────

/** Wire-protocol version. Bump when message shapes change. */
export const protocolVersion = 1;

/** Snapshot schema version. Bump when element/group shapes change. */
export const schemaVersion = 1;

// ─── Timeout Constants ──────────────────────────────────────────────

export const LAUNCH_TIMEOUT_MS = 15_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 10_000;
export const RECONNECT_GRACE_MS = 20_000;

// ─── Runtime State ──────────────────────────────────────────────────

export type RuntimeState =
  | 'idle'
  | 'starting_ws'
  | 'launching_browser'
  | 'waiting_for_extension'
  | 'ready'
  | 'disconnected_temporarily'
  | 'failed';

// ─── Tab State ──────────────────────────────────────────────────────

export type TabStatus = 'discovered' | 'controlled' | 'active' | 'stale' | 'closed';

export interface TabState {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  controlled: boolean;
  status: TabStatus;
  lastSeenAt: number;
  snapshotVersion: number;
}

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
  | 'status';

export interface BrowserCommand {
  id: string;
  command: BrowserCommandName;
  tabId?: number;
  args?: Record<string, unknown>;
}

export interface BrowserResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BrowserError;
  pageState?: PageState;
}

export interface BrowserError {
  code: BrowserErrorCode;
  message: string;
  details?: string;
  recoverable: boolean;
  suggestedNextStep?: string;
}

export type BrowserErrorCode =
  | 'transport_error'
  | 'tab_not_found'
  | 'element_not_found'
  | 'stale_snapshot'
  | 'timeout'
  | 'policy_blocked'
  | 'page_changed'
  | 'unsupported'
  | 'extension_unavailable'
  | 'browser_unavailable';

// ─── Handshake ───────────────────────────────────────────────────────

export interface ExtensionHello {
  type: 'hello';
  protocolVersion: number;
  extensionVersion: string;
  profileId: string;
  activeTab?: { tabId: number; url: string; title: string };
  capabilities: string[];
  browser: {
    name: string;
    version: string;
    userAgent: string;
  };
}

export interface JanusWelcome {
  type: 'welcome';
  sessionId: string;
  acceptedProtocolVersion: number;
  ready: boolean;
  policyMode: 'read_only' | 'controlled' | 'full';
  enabledCapabilities: string[];
  snapshotConfig: SnapshotConfig;
}

export interface SnapshotConfig {
  viewportOnly: boolean;
  maxElements: number;
  maxGroups: number;
}

export const DEFAULT_SNAPSHOT_CONFIG: SnapshotConfig = {
  viewportOnly: true,
  maxElements: 100,
  maxGroups: 25,
};

// ─── Snapshot ────────────────────────────────────────────────────────

export interface PageSnapshot {
  schemaVersion: number;
  snapshotVersion: number;
  page: PageMetadata;
  state: PageState;
  elements: SnapshotElement[];
  groups: SnapshotGroup[];
  diagnostics: SnapshotDiagnostics;
}

export interface PageMetadata {
  url: string;
  domain: string;
  title: string;
  language?: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  timestamp: string;
  tabId?: number;
  pageTypeHints: string[];
}

export interface PageState {
  readyState: string;
  loadingState: 'loading' | 'interactive' | 'stable' | 'changing';
  dialogOpen: boolean;
  modalOpen: boolean;
  captchaVisible: boolean;
  requiresUserAttention: boolean;
}

export type ElementKind =
  | 'actionable'
  | 'content'
  | 'input'
  | 'navigation'
  | 'result_item'
  | 'warning'
  | 'status';

export interface SnapshotElement {
  id: string;
  kind: ElementKind;
  tag: string;
  role: string | null;
  text: string;
  accessibleName: string | null;
  placeholder: string | null;
  name: string | null;
  type: string | null;
  href: string | null;
  valuePreview: string | null;
  visible: boolean;
  enabled: boolean | null;
  interactive: boolean;
  checked: boolean | null;
  selected: boolean | null;
  bbox: { x: number; y: number; width: number; height: number } | null;
  groupId: string | null;
  semanticHints: string[];
}

export type GroupKind =
  | 'result_card'
  | 'product_card'
  | 'search_result'
  | 'form_section'
  | 'nav_section'
  | 'dialog'
  | 'table_row'
  | 'filter_panel'
  | 'pagination'
  | 'header'
  | 'footer';

export interface SnapshotGroup {
  id: string;
  kind: GroupKind;
  label: string;
  elementIds: string[];
  semanticHints: string[];
}

export interface SnapshotDiagnostics {
  totalVisibleNodesScanned: number;
  totalElementsReturned: number;
  truncationApplied: boolean;
  warnings: string[];
}

// ─── Wait Conditions ─────────────────────────────────────────────────

export type WaitCondition =
  | { type: 'urlMatches'; pattern: string; timeoutMs?: number }
  | { type: 'elementExists'; text?: string; semanticType?: string; timeoutMs?: number }
  | { type: 'textVisible'; text: string; timeoutMs?: number }
  | { type: 'domStable'; stableForMs?: number; timeoutMs?: number }
  | { type: 'timeoutOnly'; timeoutMs: number };

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
  wsServerRunning: boolean;
  extensionConnected: boolean;
  sessionId: string | null;
  activeTabCount: number;
  lastHandshakeAt: number | null;
  protocolVersion: number;
  uptime: number;
}

// ─── Constants ───────────────────────────────────────────────────────

export const BROWSER_WS_PORT = 19816;
export const BROWSER_WS_URL = `ws://127.0.0.1:${BROWSER_WS_PORT}`;
export const EXTENSION_VERSION = '0.1.0';
