/**
 * Janus Browser Operator — Popup UI.
 * Shows real-time connection status and runtime info.
 * Reads state from chrome.storage.session (persisted by background.ts).
 */

interface PopupState {
  sessionId: string | null;
  connectionState: 'connected' | 'disconnected';
  policyMode: string | null;
  lastHandshakeAt: number | null;
  protocolVersion?: number;
  enabledCapabilities?: string[];
}

const $ = (id: string) => document.getElementById(id)!;

async function refresh(): Promise<void> {
  // Read persisted state from background
  let state: PopupState | null = null;
  try {
    const result = await chrome.storage.session.get('janusState');
    state = (result.janusState as PopupState) ?? null;
  } catch {
    // storage.session not available
  }

  const dot = $('statusDot');
  const connStatus = $('connStatus');
  const sessionEl = $('sessionId');
  const handshakeEl = $('lastHandshake');
  const policyEl = $('policyMode');
  const protocolEl = $('protocol');
  const capsEl = $('capabilities');
  const tabEl = $('activeTab');
  const extEl = $('extVersion');

  // Extension version from manifest
  const manifest = chrome.runtime.getManifest();
  extEl.textContent = `v${manifest.version}`;

  if (!state || state.connectionState !== 'connected') {
    dot.className = 'status-dot disconnected';
    connStatus.textContent = 'Disconnected';
    connStatus.className = 'value error';
    sessionEl.textContent = '—';
    handshakeEl.textContent = '—';
    policyEl.textContent = '—';
    protocolEl.textContent = '—';
    capsEl.textContent = '—';
  } else {
    dot.className = 'status-dot connected';
    connStatus.textContent = 'Connected';
    connStatus.className = 'value ok';

    sessionEl.textContent = state.sessionId
      ? state.sessionId.slice(0, 8) + '...'
      : '—';

    if (state.lastHandshakeAt) {
      const ago = Math.round((Date.now() - state.lastHandshakeAt) / 1000);
      handshakeEl.textContent = ago < 60
        ? `${ago}s ago`
        : `${Math.round(ago / 60)}m ago`;
    }

    policyEl.textContent = state.policyMode ?? '—';
    policyEl.className = state.policyMode === 'read_only' ? 'value ok' : 'value warn';

    protocolEl.textContent = state.protocolVersion ? `v${state.protocolVersion}` : '—';

    if (state.enabledCapabilities?.length) {
      capsEl.textContent = `${state.enabledCapabilities.length} active`;
      capsEl.title = state.enabledCapabilities.join(', ');
    }
  }

  // Active tab info
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const url = new URL(tab.url);
      tabEl.textContent = url.hostname;
      tabEl.title = tab.url;
    }
  } catch {
    tabEl.textContent = '—';
  }
}

// Refresh on open
refresh();

// Auto-refresh every 2s while popup is open
setInterval(refresh, 2000);

// Listen for storage changes (real-time updates from background)
chrome.storage.session.onChanged.addListener(() => {
  refresh();
});
