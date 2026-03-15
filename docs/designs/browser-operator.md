# Janus Browser Operator — MVP Implementation Plan

**Status:** Draft
**Created:** 2026-03-15
**Author:** wt

## Goal

Build a lightweight browser automation layer for Janus that controls a real Chrome profile through a custom Chrome extension, instead of using Playwright as the main shopping/research runtime.

### Primary goals

1. Make Chrome the first-class target.
2. Use a dedicated persistent browser profile for Janus.
3. Keep the agent on top of a small action protocol, not raw DOM or CSS selectors.
4. Start with a read-only / low-risk interaction model suitable for shopping, research, search, and simple navigation.
5. Keep architecture simple, local, and easy to debug.

### Non-goals for MVP

1. No cloud relay.
2. No OpenClaw dependency.
3. No remote CDP.
4. No payment / checkout automation.
5. No generic visual "computer use" based on screen coordinates.
6. No multi-browser abstraction layer yet.
7. No full test framework.

---

## High-level architecture

1. **Janus Core** — Plans next browser actions. Calls a local browser bridge tool. Consumes structured snapshots.
2. **Browser Bridge (local service)** — Runs locally on the same machine as Chrome. Exposes a simple HTTP or WebSocket API. Sends commands to the Chrome extension. Applies safety rules and validates responses.
3. **Chrome Extension** — Installed only in a dedicated Janus Chrome profile. Performs actual page operations in the active tab. Creates structured snapshots of visible, relevant DOM elements. Returns results to the bridge.
4. **Dedicated Chrome profile** — Separate from your personal profile. Persistent across runs. Used only for Janus tasks.

### Runtime flow

```
User request
→ Janus intent parser
→ shopping/research workflow planner
→ browser bridge command
→ extension action in Chrome
→ result / snapshot back to bridge
→ normalized result back to Janus
→ final answer to user
```

---

## Core product decision

**Do not make Janus think in CSS selectors. Make Janus think in page snapshots with numbered or stable element references.**

Example mental model:
- e1: search input "Szukaj"
- e2: button "Szukaj"
- e3: product "Lavazza Crema e Aroma 1kg"
- e4: price "49,99 zł"
- e5: product "Dallmayr Prodomo 500g"
- e6: price "23,49 zł"

Janus should plan with actions like:
- click e1
- type into e1 "lavazza 1kg kawa ziarnista"
- press Enter
- wait for results
- capture snapshot
- extract products and prices

---

## Phase 1 — Define the Protocol

### Commands to support in MVP

1. openTab
2. focusTab
3. navigate
4. getCurrentUrl
5. snapshot
6. click
7. type
8. pressKey
9. scroll
10. waitFor
11. extractText
12. screenshot
13. closeTab
14. ping

### Wait conditions

1. urlMatches
2. elementExists
3. elementTextContains
4. domStable
5. timeoutOnly

### Data contracts

```typescript
type BrowserCommand = {
  id: string;
  command:
    | 'openTab' | 'focusTab' | 'navigate' | 'getCurrentUrl'
    | 'snapshot' | 'click' | 'type' | 'pressKey' | 'scroll'
    | 'waitFor' | 'extractText' | 'screenshot' | 'closeTab' | 'ping';
  tabId?: number;
  payload?: Record<string, unknown>;
};

type SnapshotElement = {
  id: string;
  tag: string;
  role?: string;
  text?: string;
  ariaLabel?: string;
  placeholder?: string;
  href?: string;
  inputType?: string;
  value?: string;
  visible: boolean;
  enabled: boolean;
  interactive: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  semanticType?:
    | 'searchInput' | 'button' | 'link' | 'productTitle'
    | 'price' | 'input' | 'filter' | 'text' | 'unknown';
};

type PageSnapshot = {
  url: string;
  title: string;
  capturedAt: string;
  elements: SnapshotElement[];
  visibleTextSummary?: string[];
};

type WaitCondition =
  | { type: 'urlMatches'; pattern: string; timeoutMs?: number }
  | { type: 'elementExists'; text?: string; semanticType?: string; timeoutMs?: number }
  | { type: 'textVisible'; text: string; timeoutMs?: number }
  | { type: 'domStable'; stableForMs?: number; timeoutMs?: number }
  | { type: 'timeoutOnly'; timeoutMs: number };

type PolicyDecision = {
  allowed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
};
```

---

## Phase 2 — Chrome Extension

### Manifest V3

```json
{
  "manifest_version": 3,
  "name": "Janus Browser Operator",
  "version": "0.1.0",
  "permissions": ["activeTab", "scripting", "storage", "tabs"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

### Background script responsibilities

1. Accept commands from the bridge.
2. Resolve active or target tab.
3. Route the command to the content script.
4. Handle tab-level operations (open, focus, close, navigate).
5. Return results.

### Content script responsibilities

1. Build page snapshots.
2. Resolve element reference IDs.
3. Execute click, type, extract, scroll, and wait actions.
4. Return normalized results.

### Implementation order

1. ping
2. getCurrentUrl
3. snapshot
4. click
5. type
6. pressKey
7. scroll
8. waitFor
9. screenshot

---

## Phase 3 — Snapshot System

### Inclusion rules

Include: visible buttons, links, inputs, textareas, selects, price-like text, product title-like nodes, key headings and labels.

Exclude: hidden elements, tiny layout wrappers, decorative spans, scripts/styles, irrelevant containers.

### Semantic inference heuristics

- Inputs with placeholder containing "szukaj" or "search" → `searchInput`
- Text matching currency patterns → `price`
- Links/headings inside listing cards → `productTitle`
- Button text like "kup", "dodaj", "szukaj", "filtruj" → `button` or `filter`

```typescript
const PRICE_REGEX = /(\d+[\.,]\d{2})\s?(zl|pln|zł|eur|€)/i;
const SEARCH_HINT_REGEX = /(szukaj|search|czego szukasz)/i;
```

Stable synthetic IDs: `e1, e2, e3` per snapshot. Snapshot-local, not reused across snapshots.

---

## Phase 4 — Browser Bridge

### Responsibilities

1. Accept API requests from Janus.
2. Forward commands to the extension.
3. Correlate request IDs.
4. Apply policy checks.
5. Apply timeouts.
6. Log all browser actions.
7. Normalize errors.

### Communication

Extension opens WebSocket to `ws://127.0.0.1:<port>`. Bridge sends commands over that socket. Extension returns results.

### API

- `POST /command`
- `GET /health`
- `GET /tabs`
- `GET /logs/recent`

---

## Phase 5 — Safety Policy

### MVP rule: Read-only by default.

### Blocked/restricted

- File uploads
- Downloads without confirmation
- Payment confirmation / checkout submission
- Final purchase buttons

### Dangerous action text

```typescript
const DANGEROUS_ACTION_TEXT = [
  'kup teraz', 'buy now', 'place order', 'pay',
  'checkout', 'zamawiam', 'potwierdzam zakup'
];
```

---

## Phase 6 — Janus Tool Integration

### Tools

1. browser_open_url
2. browser_snapshot
3. browser_click
4. browser_type
5. browser_press_key
6. browser_scroll
7. browser_wait
8. browser_extract_text
9. browser_screenshot
10. browser_get_url

---

## Phase 7 — Shopping Workflow MVP

### Flow

1. Open marketplace homepage.
2. Capture snapshot.
3. Find search input.
4. Type query.
5. Submit search.
6. Wait for results.
7. Capture snapshot.
8. Extract product titles and prices.
9. Normalize prices.
10. Return ranked offers.

### Normalized offer type

```typescript
type ExtractedOffer = {
  title: string;
  priceValue?: number;
  currency?: string;
  href?: string;
  shippingText?: string;
  source?: string;
};
```

---

## Phase 8 — Wait Model and Reliability

### Required primitives

1. Wait for URL pattern.
2. Wait for N matching elements in snapshot.
3. Wait for DOM stability for X ms.
4. Wait for visible text.

### Post-action checks

1. Did URL change?
2. Did snapshot change meaningfully?
3. Did expected element disappear?
4. Did a popup/modal appear?
5. Did a CAPTCHA appear?

---

## Phase 9 — Error Handling

### Error classes

1. ElementNotFoundError
2. ElementNotInteractableError
3. PageNavigationError
4. TimeoutError
5. PolicyBlockedError
6. CaptchaDetectedError
7. BridgeDisconnectedError

### On failure, save

1. Current URL
2. Current snapshot summary
3. Screenshot if available
4. Raw error

---

## Phase 10 — Dedicated Chrome Profile

### Rules

1. Never use daily browser profile.
2. One dedicated Janus profile.
3. Persistent across runs.
4. Install only required extensions.

### Launch examples

```bash
# macOS
open -na "Google Chrome" --args --user-data-dir="$HOME/.janus/chrome-profile"

# Linux
google-chrome --user-data-dir="$HOME/.janus/chrome-profile"
```

---

## Implementation Order

1. Shared types and protocol.
2. Extension skeleton (manifest, background, content script).
3. Bridge skeleton.
4. ping command.
5. getCurrentUrl command.
6. openTab / navigate / focusTab.
7. snapshot generation.
8. click by elementId.
9. type by elementId.
10. pressKey.
11. scroll.
12. waitFor basic conditions.
13. screenshot.
14. Janus wrapper tool.
15. shopping_search_product workflow.
16. shopping_extract_results workflow.
17. offer normalization and ranking.
18. safety policy hardening.
19. logging and failure dump.
20. first end-to-end tests.

---

## Acceptance Scenarios

### Scenario 1 — open and inspect page

1. Start Janus profile Chrome manually.
2. Connect extension to bridge.
3. Run ping.
4. Open allegro.pl.
5. Get current URL.
6. Capture snapshot.
7. Save screenshot.

### Scenario 2 — search product

1. Open allegro.pl.
2. Capture snapshot.
3. Identify search field.
4. Type "lavazza 1kg".
5. Submit search.
6. Wait for results.
7. Capture snapshot.
8. Return top 5 visible results with prices.

### Scenario 3 — safety policy test

1. Open commerce page.
2. Attempt to click button matching dangerous action text.
3. Verify policy block.

---

## MVP Complete When

1. Janus can control a dedicated Chrome profile through the extension.
2. Janus can open pages, capture snapshots, click, type, scroll, wait, and screenshot.
3. Janus can search a product on Allegro in a real browser tab.
4. Janus can extract visible titles and prices from a results page.
5. Dangerous purchase-like actions are blocked by policy.
6. Failures are logged with enough detail to debug.

---

## Post-MVP Roadmap

1. Better listing-card grouping.
2. Better popup and modal handling.
3. Per-domain heuristics.
4. Better price normalization and unit comparison.
5. Human-confirmation workflow for sensitive actions.
6. Search engine fallback.
7. Optional Brave/Chromium support.
8. Optional Native Messaging if WebSocket becomes bottleneck.

---

## Simplification Notes (from review)

1. **Bridge may be skipped for MVP** — Extension WebSocket directly to Janus tool. Bridge adds value when policy layer or multi-browser needed.
2. **Monorepo packages premature** — Start with `chrome-extension/` folder + `browser-operator.ts` tool in janus-agent.
3. **Shopping workflows are Phase 2** — Agent has LLM, sees snapshot, plans actions itself. Hardcoded workflows come later for optimization.
