---
name: browser-operator
description: "Real browser automation via Playwright. Use when a real browser session is needed — blocked sites (403, CAPTCHA), JS-heavy pages, shopping flows, multi-step navigation, or form filling."
version: "2.0.0"
always: false
---

# Browser Operator

Control a real Chrome browser via Playwright. The browser uses a persistent profile with real cookies — sites treat it as a normal user, not a bot.

## When to use

- web_fetch returned 403, CAPTCHA, or blocking
- Pages that require JavaScript rendering
- Shopping and price research flows
- Multi-step navigation (search → results → details)
- Form filling on dynamic sites
- Any site that needs a real browser session

## When NOT to use

- Simple API calls (use web_fetch)
- Static pages that web_fetch handles fine
- Tasks that don't need a browser

## Core workflow

Always follow this pattern:

```
1. navigate to URL
2. snapshot (see what's on the page)
3. decide what to do based on snapshot
4. act (click, type, pressKey)
5. wait for page to settle
6. snapshot again to verify result
```

**Never act without a snapshot first.**

## Commands

### Navigation
```
browser({ command: "navigate", args: { url: "https://allegro.pl" } })
browser({ command: "getCurrentUrl" })
```

### Observation (always do first)
```
browser({ command: "snapshot" })
browser({ command: "extractText" })
```

### Screenshot (debugging and visual confirmation only)
```
browser({ command: "screenshot" })
```
Screenshot is for debugging, fallback inspection, or visual confirmation — not the primary reasoning source. Always use snapshot for action planning.

### Interaction
```
browser({ command: "click", args: { elementId: "e5" } })
browser({ command: "type", args: { elementId: "e1", text: "lavazza 1kg", clear: true } })
browser({ command: "pressKey", args: { key: "Enter" } })
browser({ command: "scroll", args: { deltaY: 500 } })
```

### Waiting (use after navigation or click)
```
browser({ command: "waitFor", args: { type: "domStable", stableForMs: 1200, timeoutMs: 10000 } })
browser({ command: "waitFor", args: { type: "urlMatches", pattern: "search", timeoutMs: 10000 } })
browser({ command: "waitFor", args: { type: "textVisible", text: "Wyniki", timeoutMs: 5000 } })
```

### Diagnostics
```
browser({ command: "status" })
browser({ command: "ping" })
```

## Understanding snapshots

Snapshots use Playwright's AI-native snapshot format. Each element has a ref (e1, e2, e3...) you use for actions.

Example snapshot output:
```
- generic [ref=e2]:
  - heading "Example Domain" [level=1] [ref=e3]
  - paragraph [ref=e4]: Some text content here.
  - link "Learn more" [ref=e5] [cursor=pointer]:
    - /url: https://example.com/more
```

Key things to look for:
- `[ref=eN]` — reference for click/type (e.g. "e5")
- Element roles — heading, link, button, textbox, etc.
- Text content — visible text next to elements
- URL annotations — `/url:` for links

## Rules

1. **Always snapshot before acting.** Element refs are only valid for the current snapshot. Never click/type without seeing the page first.
2. **After navigate and click — resnapshot.** The page changed, your old references are stale.
3. **Use `waitFor`, never fixed sleeps.** After navigation or click, always `waitFor({ type: "domStable" })` before snapshotting.
4. **Avoid long blind action chains.** After a few actions on the same page state, resnapshot and reconsider.
5. **Read the page through snapshot, don't guess.** If you're unsure what's on the page, snapshot. Don't assume structure.
6. **Handle blockers first.** Cookie banners, modals, overlays — use dismissCookies or dismiss them before acting on the page behind them.
7. **Don't try to circumvent policy.** Checkout/payment buttons are blocked. Don't try workarounds.
8. **Keep workflows short.** If a task takes too many browser actions, give the user a link and let them finish manually.
9. **Prefer snapshot over extractText.** Snapshot gives structure and element references. extractText gives raw text but no actionability.
10. **If the browser runtime behaves unexpectedly**, call `browser({ command: "status" })` before retrying multiple actions.

## Shopping workflow example

```
# 1. Open marketplace
browser({ command: "navigate", args: { url: "https://allegro.pl" } })
browser({ command: "waitFor", args: { type: "domStable", stableForMs: 1500 } })
browser({ command: "snapshot" })

# 2. Handle cookie banner if present
browser({ command: "dismissCookies" })

# 3. Find search input from snapshot refs
browser({ command: "click", args: { elementId: "e1" } })
browser({ command: "type", args: { elementId: "e1", text: "lavazza crema 1kg", clear: true } })
browser({ command: "pressKey", args: { key: "Enter" } })

# 4. Wait for results
browser({ command: "waitFor", args: { type: "domStable", stableForMs: 1500, timeoutMs: 10000 } })
browser({ command: "snapshot" })

# 5. Extract product info from snapshot refs
# Return structured results to user
```

## Error recovery

- **Element not found:** Request a new snapshot — the page likely changed.
- **Timeout:** The page might be slow. Try `waitFor` with longer timeout, or take a screenshot to debug.
- **Browser unavailable:** Runtime failed to start. Check that Chrome/Chromium and Playwright are installed.
- **Unexpected behavior:** Call `browser({ command: "status" })` to check runtime health before retrying.

## Tab management

```
browser({ command: "openTab", args: { url: "https://example.com" } })
browser({ command: "focusTab", args: { tabId: 0 } })
browser({ command: "closeTab", args: { tabId: 1 } })
```

Tab IDs are zero-based page indices. Use sparingly. Prefer single-tab workflows.
