/**
 * Janus Browser Operator — Content Script.
 *
 * Runs in every page. Handles:
 * - Page snapshot generation (with schemaVersion, password masking)
 * - Element interactions (click, type, pressKey, scroll)
 * - Wait conditions
 * - Text extraction
 */

const SCHEMA_VERSION = 1;

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'command') return false;

  handleContentCommand(message)
    .then(sendResponse)
    .catch(err => {
      sendResponse({
        ok: false,
        error: {
          code: 'content_error',
          message: err instanceof Error ? err.message : String(err),
          recoverable: true,
        },
      });
    });

  return true; // async response
});

async function handleContentCommand(cmd: { command: string; args?: Record<string, unknown>; snapshotConfig?: { viewportOnly: boolean; maxElements: number; maxGroups: number } }): Promise<unknown> {
  switch (cmd.command) {
    case 'snapshot':
      return buildSnapshot(cmd.snapshotConfig);

    case 'click':
      return clickElement(String(cmd.args?.elementId ?? ''));

    case 'type':
      return typeIntoElement(String(cmd.args?.elementId ?? ''), String(cmd.args?.text ?? ''), Boolean(cmd.args?.clear));

    case 'pressKey':
      return pressKey(String(cmd.args?.key ?? 'Enter'));

    case 'scroll':
      return scrollPage(Number(cmd.args?.deltaY ?? 300));

    case 'waitFor':
      return waitForCondition(cmd.args as Record<string, unknown>);

    case 'extractText':
      return extractVisibleText();

    default:
      return { ok: false, error: { code: 'unsupported', message: `Content: unknown command ${cmd.command}`, recoverable: false } };
  }
}

// ─── Element Registry (per snapshot) ─────────────────────────────────

let currentElements: Map<string, Element> = new Map();
let snapshotVersion = 0;

// ─── Snapshot ────────────────────────────────────────────────────────

function buildSnapshot(config?: { viewportOnly: boolean; maxElements: number; maxGroups: number }): { ok: boolean; result: unknown } {
  const maxElements = config?.maxElements ?? 100;
  const viewportOnly = config?.viewportOnly ?? true;

  snapshotVersion++;
  currentElements.clear();

  const allElements = document.querySelectorAll('body *');
  const candidates: Array<{ el: Element; rect: DOMRect }> = [];

  for (const el of allElements) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (viewportOnly && (rect.bottom < 0 || rect.top > window.innerHeight)) continue;
    if (!isRelevant(el)) continue;
    candidates.push({ el, rect });
  }

  // Sort by visual reading order (top-left to bottom-right)
  candidates.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

  // Build elements with IDs
  const elements: unknown[] = [];
  let idx = 1;

  for (const { el, rect } of candidates) {
    if (idx > maxElements) break;

    const id = `e${idx}`;
    currentElements.set(id, el);

    elements.push({
      id,
      kind: classifyKind(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || computedRole(el) || null,
      text: normalizeText(el.textContent ?? ''),
      accessibleName: getAccessibleName(el),
      placeholder: (el as HTMLInputElement).placeholder || null,
      name: el.getAttribute('name') || null,
      type: (el as HTMLInputElement).type || null,
      href: (el as HTMLAnchorElement).href || null,
      valuePreview: getValuePreview(el),
      visible: true,
      enabled: !(el as HTMLInputElement).disabled,
      interactive: isInteractive(el),
      checked: (el as HTMLInputElement).checked ?? null,
      selected: (el as HTMLOptionElement).selected ?? null,
      bbox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      groupId: null, // v1: no grouping yet
      semanticHints: inferSemanticHints(el),
    });
    idx++;
  }

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    snapshotVersion,
    page: {
      url: location.href,
      domain: location.hostname,
      title: document.title,
      language: document.documentElement.lang || null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      timestamp: new Date().toISOString(),
      pageTypeHints: inferPageTypeHints(),
    },
    state: {
      readyState: document.readyState,
      loadingState: document.readyState === 'complete' ? 'stable' : 'loading',
      dialogOpen: !!document.querySelector('dialog[open]'),
      modalOpen: !!document.querySelector('[role="dialog"], [aria-modal="true"]'),
      captchaVisible: detectCaptcha(),
      requiresUserAttention: detectCaptcha() || detectLoginGate(),
    },
    elements,
    groups: [], // v1: groups implemented later
    diagnostics: {
      totalVisibleNodesScanned: candidates.length,
      totalElementsReturned: elements.length,
      truncationApplied: candidates.length > maxElements,
      warnings: [] as string[],
    },
  };

  return { ok: true, result: snapshot };
}

// ─── Actions ─────────────────────────────────────────────────────────

function clickElement(elementId: string): { ok: boolean; result?: unknown; error?: unknown } {
  const el = currentElements.get(elementId);
  if (!el) return { ok: false, error: { code: 'element_not_found', message: `Element ${elementId} not found (snapshot v${snapshotVersion})`, recoverable: true, suggestedNextStep: 'Request a new snapshot' } };

  (el as HTMLElement).click();
  return { ok: true, result: { clicked: elementId } };
}

function typeIntoElement(elementId: string, text: string, clear: boolean): { ok: boolean; result?: unknown; error?: unknown } {
  const el = currentElements.get(elementId);
  if (!el) return { ok: false, error: { code: 'element_not_found', message: `Element ${elementId} not found`, recoverable: true, suggestedNextStep: 'Request a new snapshot' } };

  const input = el as HTMLInputElement;
  input.focus();
  if (clear) input.value = '';
  input.value += text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, result: { typed: text, elementId } };
}

function pressKey(key: string): { ok: boolean; result?: unknown } {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  document.activeElement?.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true }));
  document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));

  // Special handling for Enter — also submit if in a form
  if (key === 'Enter' && document.activeElement) {
    const form = (document.activeElement as HTMLElement).closest('form');
    if (form) form.requestSubmit();
  }

  return { ok: true, result: { key } };
}

function scrollPage(deltaY: number): { ok: boolean; result?: unknown } {
  window.scrollBy(0, deltaY);
  return { ok: true, result: { scrolledBy: deltaY, newScrollY: window.scrollY } };
}

async function waitForCondition(condition: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
  const type = String(condition.type ?? 'timeoutOnly');
  const timeoutMs = Number(condition.timeoutMs ?? 5000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (type === 'urlMatches' && new RegExp(String(condition.pattern ?? '')).test(location.href)) {
      return { ok: true, result: { matched: 'urlMatches', url: location.href } };
    }
    if (type === 'textVisible' && document.body.textContent?.includes(String(condition.text ?? ''))) {
      return { ok: true, result: { matched: 'textVisible' } };
    }
    if (type === 'elementExists') {
      const text = condition.text ? String(condition.text) : null;
      if (text && document.body.textContent?.includes(text)) {
        return { ok: true, result: { matched: 'elementExists' } };
      }
    }
    if (type === 'domStable') {
      const stableMs = Number(condition.stableForMs ?? 1000);
      const stable = await waitForDomStable(stableMs, deadline - Date.now());
      if (stable) return { ok: true, result: { matched: 'domStable' } };
    }
    if (type === 'timeoutOnly') {
      await sleep(timeoutMs);
      return { ok: true, result: { matched: 'timeoutOnly' } };
    }
    await sleep(200);
  }

  return { ok: false, error: { code: 'timeout', message: `Wait condition "${type}" timed out after ${timeoutMs}ms`, recoverable: true } };
}

function extractVisibleText(): { ok: boolean; result: unknown } {
  const text = document.body?.innerText ?? '';
  const truncated = text.length > 5000 ? text.slice(0, 5000) + '\n...[truncated]' : text;
  return { ok: true, result: { text: truncated, length: text.length } };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isRelevant(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  // Always include interactive elements
  if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return true;
  // Include elements with click handlers or roles
  if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return true;
  if ((el as HTMLElement).onclick || el.getAttribute('tabindex')) return true;
  // Include meaningful text nodes
  const text = (el.textContent ?? '').trim();
  if (text.length > 2 && text.length < 200 && el.children.length === 0) return true;
  // Include headings
  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return true;
  return false;
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return true;
  if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return true;
  if (el.getAttribute('tabindex')) return true;
  return false;
}

function classifyKind(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return 'input';
  if (['a'].includes(tag)) return 'navigation';
  if (['button'].includes(tag) || el.getAttribute('role') === 'button') return 'actionable';
  return 'content';
}

function computedRole(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' && (el as HTMLAnchorElement).href) return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return null;
}

function getAccessibleName(el: Element): string | null {
  return el.getAttribute('aria-label')
    ?? el.getAttribute('title')
    ?? (el as HTMLInputElement).placeholder
    ?? null;
}

function getValuePreview(el: Element): string | null {
  const input = el as HTMLInputElement;

  // Password masking: never expose password field values
  if (input.type === 'password') return null;

  const val = input.value;
  if (!val) return null;
  return val.length > 80 ? val.slice(0, 77) + '...' : val;
}

function normalizeText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 160 ? normalized.slice(0, 157) + '...' : normalized;
}

const PRICE_REGEX = /(\d+[\.,]\d{2})\s?(zl|zl|pln|eur|\u20ac|\$|usd|gbp|\u00a3)/i;
const SEARCH_HINT_REGEX = /(szukaj|search|czego szukasz|wyszukaj)/i;

function inferSemanticHints(el: Element): string[] {
  const hints: string[] = [];
  const text = (el.textContent ?? '').trim().toLowerCase();
  const placeholder = ((el as HTMLInputElement).placeholder ?? '').toLowerCase();
  const tag = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type ?? '';

  if ((tag === 'input' || tag === 'textarea') && (type === 'search' || SEARCH_HINT_REGEX.test(placeholder))) {
    hints.push('search_input');
  }
  if (PRICE_REGEX.test(text)) hints.push('product_price');
  if (tag === 'a' && el.closest('[class*="product"], [class*="listing"], [class*="offer"], [data-testid*="product"]')) {
    hints.push('product_title');
  }
  if (text.includes('cookie') || text.includes('accept') || text.includes('zgadzam')) {
    hints.push('cookie_accept');
  }

  return hints;
}

function inferPageTypeHints(): string[] {
  const hints: string[] = [];
  const url = location.href.toLowerCase();

  if (url.includes('/search') || url.includes('?q=') || url.includes('?string=') || url.includes('query=')) {
    hints.push('search_results');
  }
  if (url.includes('allegro.pl') || url.includes('amazon') || url.includes('ebay')) {
    hints.push('marketplace');
  }
  if (url.includes('google.com/search') || url.includes('duckduckgo.com') || url.includes('bing.com/search')) {
    hints.push('search_engine');
  }
  if (document.querySelector('form[action*="login"], form[action*="signin"], input[type="password"]')) {
    hints.push('login_page');
  }

  return hints;
}

function detectCaptcha(): boolean {
  const html = document.documentElement.innerHTML.toLowerCase();
  const signals = ['captcha', 'recaptcha', 'hcaptcha', 'cf-challenge', 'challenge-platform'];
  return signals.filter(s => html.includes(s)).length >= 2;
}

function detectLoginGate(): boolean {
  return !!document.querySelector('input[type="password"]');
}

function waitForDomStable(stableMs: number, maxWaitMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let lastMutation = Date.now();
    const startTime = Date.now();
    const observer = new MutationObserver(() => { lastMutation = Date.now(); });
    observer.observe(document.body, { childList: true, subtree: true });

    const check = setInterval(() => {
      if (Date.now() - lastMutation >= stableMs) {
        observer.disconnect();
        clearInterval(check);
        resolve(true);
      }
      if (Date.now() - startTime > maxWaitMs) {
        observer.disconnect();
        clearInterval(check);
        resolve(false);
      }
    }, 100);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
