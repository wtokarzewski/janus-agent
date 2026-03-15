---
name: browser-operator
description: "Real browser automation via Chrome Extension. Use when web_fetch fails (403, CAPTCHA, blocked sites), for shopping/price research, filling forms, navigating multi-step flows, or any task that needs a real browser session. Preferred over web_fetch for e-commerce sites (Allegro, Amazon, eBay, Ceneo)."
version: "1.0.0"
always: false
---

# Browser Operator

Control a real Chrome browser through a dedicated extension. The browser uses a persistent profile with real cookies — sites treat it as a normal user, not a bot.

## When to use

- web_fetch returned 403, CAPTCHA, or blocking
- Shopping/price comparison on e-commerce sites
- Pages that require JavaScript rendering
- Multi-step navigation flows (search → results → details)
- Form filling
- Any site that blocks automated access

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
browser({ command: "screenshot" })
browser({ command: "extractText" })
```

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

Snapshots return structured page maps, not raw HTML. Each element has an ID (e1, e2, e3...) you use for actions.

Key fields per element:
- `id` — reference for click/type (e.g. "e12")
- `kind` — actionable, input, navigation, content
- `text` — visible text
- `semanticHints` — ["search_input", "product_price", "cookie_accept", etc.]
- `interactive` — can you click/type here?

Key page state:
- `state.captchaVisible` — if true, STOP and tell the user
- `state.requiresUserAttention` — if true, tell the user (login gate, CAPTCHA, etc.)
- `state.modalOpen` — handle the modal first before acting on page behind it

## Rules

1. **Always snapshot before acting.** Element IDs are only valid for the current snapshot. Never click/type without seeing the page first.
2. **After navigate and click — resnapshot.** The page changed, your old references are stale.
3. **When `requiresUserAttention` or `captchaVisible` → STOP.** Tell the user what's blocking and give a direct link. Don't try to solve CAPTCHAs or bypass login gates.
4. **Use `waitFor`, never fixed sleeps.** After navigation or click, always `waitFor({ type: "domStable" })` before snapshotting.
5. **Don't do too many actions without re-evaluating.** Max 5 actions per page state. Then resnapshot and reconsider.
6. **Read the page through snapshot, don't guess.** If you're unsure what's on the page, snapshot. Don't assume structure.
7. **Handle blockers first.** Cookie banners, modals, overlays — dismiss them before acting on the page behind them. Look for `cookie_accept` hint.
8. **Don't try to circumvent policy.** Checkout/payment buttons are blocked. Don't try workarounds.
9. **Keep workflows short.** If a task takes more than 10 browser actions, you're probably overcomplicating it. Give the user a link and let them finish manually.
10. **Prefer snapshot over extractText.** Snapshot gives structure and element references. extractText gives raw text but no actionability.

## Shopping workflow example

```
# 1. Open marketplace
browser({ command: "navigate", args: { url: "https://allegro.pl" } })
browser({ command: "waitFor", args: { type: "domStable", stableForMs: 1500 } })
browser({ command: "snapshot" })

# 2. Handle cookie banner if present (look for cookie_accept hint)
# If e3 has semanticHints: ["cookie_accept"] → click it
browser({ command: "click", args: { elementId: "e3" } })

# 3. Find search input (look for search_input hint)
browser({ command: "click", args: { elementId: "e1" } })
browser({ command: "type", args: { elementId: "e1", text: "lavazza crema 1kg", clear: true } })
browser({ command: "pressKey", args: { key: "Enter" } })

# 4. Wait for results
browser({ command: "waitFor", args: { type: "domStable", stableForMs: 1500, timeoutMs: 10000 } })
browser({ command: "snapshot" })

# 5. Extract product info from snapshot
# Look for elements with product_title and product_price hints
# Group by groupId if available
# Return structured results to user
```

## Error recovery

- **Element not found:** Request a new snapshot — the page likely changed.
- **Timeout:** The page might be slow. Try `waitFor` with longer timeout, or take a screenshot to debug.
- **Extension unavailable:** Browser runtime is not running. The tool will auto-start it.
- **Stale snapshot:** You used an old element ID. Resnapshot.

## Tab management

```
browser({ command: "openTab", args: { url: "https://example.com" } })
browser({ command: "focusTab", args: { tabId: 123 } })
browser({ command: "closeTab", args: { tabId: 123 } })
```

Use sparingly. Prefer single-tab workflows.
