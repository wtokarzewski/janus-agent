# Janus Browser Operator
## Comprehensive implementation plan from A to Z

Version: v2
Status: Planning document
Primary target: Chrome
Future compatibility target: Brave, Chromium, Edge
Document goal: define the problem, architecture, phased roadmap, MVP boundaries, extensibility model, and implementation steps for a general-purpose real-browser operator for Janus.

---

## 1. Executive summary

Janus Browser Operator is a browser control subsystem for Janus that allows the agent to interact with real websites through a real browser profile rather than a synthetic headless automation browser.

The main reason this exists is that many important websites, especially e-commerce and consumer platforms, detect and block traditional automation tools such as Playwright, Puppeteer, or generic fetch-based scraping. This happens even on a residential machine because the problem is not only IP reputation. The problem is also browser fingerprinting, session state, automation traces, lack of natural history, and behavior patterns.

The solution is to control a real browser session through a dedicated extension and a dedicated browser profile. Janus should operate on a structured snapshot abstraction of the page rather than raw CSS selectors or full DOM dumps.

This subsystem must be generic. It is not an Allegro-specific tool. It must support arbitrary websites and tasks such as:

- product research on Allegro, Amazon, eBay, Google, store sites
- search and comparison workflows
- reading and extracting structured information from pages
- filling simple forms
- navigation through multi-step flows
- screenshots and evidence capture
- future generic browser tasks beyond shopping

The architecture must be designed once, cleanly, so that we can start small and keep extending it without creating a mess.

---

## 2. Problem statement

### 2.1 The practical problem

Janus needs to help with real web tasks such as:
- find a product in a good price
- search a marketplace
- compare offers
- open a site, click through a flow, and extract visible data
- navigate search results and gather structured information

Traditional approaches fail too often on important websites.

### 2.2 Why traditional approaches fail

#### A. Direct HTTP fetch or scraping
Problems:
- 403 Forbidden
- CAPTCHA
- anti-bot challenge pages
- missing dynamic content
- no real user session context

Typical examples:
- Allegro
- Ceneo
- major e-commerce stores
- protected dynamic SPAs

#### B. Search APIs only
Search APIs can discover pages, but they often do not return:
- exact visible current price
- shipping info
- actual interactive page state
- hidden content loaded after JS execution

Search APIs are useful as optional discovery tools, but they are not sufficient as the core browser interaction layer.

#### C. Headless browser automation
Even when running locally on a home machine:
- browser fingerprint differs from real user browsing
- clean sessions look suspicious
- automation traces are visible
- a new synthetic browser context is easier to detect
- dynamic sites still challenge or degrade the session

#### D. Hardcoded scraper workflows
Hardcoded flows do not scale well:
- site-specific breakage
- selector fragility
- poor generalization
- too much maintenance

### 2.3 Root cause

The real problem is not "how do we scrape more aggressively."

The real problem is:

Janus needs to act through a real browser session with a stable profile and a clean browser interaction abstraction suitable for an LLM-driven agent.

---

## 3. Goals

### 3.1 Primary goals

1. Let Janus control a real browser tab in a dedicated browser profile.
2. Let Janus observe the page through structured snapshots instead of raw selectors.
3. Let Janus execute a small safe set of actions:
   - open
   - navigate
   - snapshot
   - click
   - type
   - press key
   - scroll
   - wait
   - screenshot
   - extract selected visible data
4. Keep the system generic so it can be used on many websites.
5. Make the design extensible so future capabilities can be added cleanly.
6. Make safety and policy part of the design from day one.
7. Keep the MVP implementation relatively small without sacrificing long-term structure.

### 3.2 Secondary goals

1. Support future browser runtimes beyond Chrome.
2. Support future task packs such as:
   - shopping
   - research
   - forms
   - monitoring
   - knowledge extraction
3. Support future remote and multi-browser execution models.
4. Support future richer state capture and debugging.

---

## 4. Non-goals for MVP

The first version should not try to do everything.

### Not in MVP
- checkout and payment execution
- purchase confirmation
- file uploads
- unrestricted arbitrary JavaScript execution from the agent
- multi-browser orchestration
- cloud remote browser infrastructure
- OCR-based screen-coordinate control
- visual-only computer use
- advanced anti-bot evasion tricks
- browserless or remote CDP deployment
- parallel tab swarm automation
- full workflow libraries for each marketplace

### Maybe later, but not now
- downloads management
- PDF export
- cookie import/export UI
- cross-session replay
- browser video recording
- mobile emulation
- authentication vault integration

---

## 5. Core design principles

### 5.1 Real browser, not synthetic browser
The browser must be a real Chrome session with a dedicated Janus profile.

### 5.2 Dedicated browser profile
Janus must never control the user's daily personal browser profile.

Use a separate profile such as:
- janus-browser
- janus-automation
- janus-runtime

This profile should:
- be persistent across runs
- keep cookies and local state
- remain isolated from the user's private daily browsing

### 5.3 Agent thinks in page abstractions, not selectors
The agent should reason over:
- element references
- labels
- roles
- visible text
- page structure

Not over:
- brittle CSS selectors
- giant raw DOM dumps
- pixel coordinates as primary mechanism

### 5.4 Small action model
The browser operator should expose a constrained set of actions.
Do not give the agent unlimited low-level power.

### 5.5 Policy first
Read-only by default.
Dangerous actions should be explicitly blocked or gated.

### 5.6 Architecture first, implementation staged
We will design the full system clearly from the beginning, but implement it in phases.
This prevents short-term hacks from becoming long-term architecture.

### 5.7 Generic operator with optional domain packs
The core browser operator must remain generic.
Site-specific or domain-specific helpers should be layered on top later.

---

## 6. High-level architecture

### 6.1 Final conceptual architecture

User
-> Janus core
-> Browser Operator tool layer
-> Browser runtime transport layer
-> Chrome Extension
-> Dedicated Chrome profile
-> Active browser tab
-> Page snapshot + action execution

### 6.2 Important clarification about "bridge"

The system needs a browser control layer, but this does not need to be a separate process in MVP.

Conceptually, the architecture should include:

- a tool/API layer inside Janus
- a transport protocol
- the extension runtime
- the content script execution layer

In MVP, the transport can be direct:
- Janus tool -> WebSocket -> extension

Later, if needed, we can split this into a separate local browser bridge service without changing the conceptual model.

### 6.3 Core runtime components

#### A. Janus Browser Operator tool
Responsibilities:
- expose browser commands to Janus
- enforce high-level validation
- manage sessions and request IDs
- translate between Janus intent and browser protocol
- apply safety and policy checks

#### B. Transport layer
Responsibilities:
- persistent communication channel
- request/response handling
- event streaming
- timeout and retry support

For MVP:
- WebSocket is preferred

#### C. Chrome Extension
Responsibilities:
- connect to Janus
- manage active tab access
- inject or coordinate content scripts
- execute actions on pages
- collect snapshots
- capture screenshots where possible
- return structured results

#### D. Content script layer
Responsibilities:
- inspect the live DOM
- detect visible and interactive elements
- build structured page snapshots
- execute click/type/scroll interactions
- extract page data

#### E. Dedicated browser profile
Responsibilities:
- maintain browser continuity
- persist cookies and storage
- separate Janus from personal browsing

---

## 7. Why this design instead of Playwright

### 7.1 We are not building another headless automation tool
Playwright is good for many things, but not as the primary foundation for this problem.

### 7.2 The browser identity matters
Real browser sessions preserve:
- fingerprint consistency
- session continuity
- realistic storage state
- cookies and browsing history
- better compatibility with real user flows

### 7.3 Better fit for protected consumer sites
Sites like:
- Allegro
- Amazon
- eBay
- Google properties
- many dynamic stores

are more tolerant of real browser interaction than synthetic automation contexts.

### 7.4 Better fit for LLM-driven control
An LLM works better with:
- semantic snapshots
- structured element references
- constrained tools

than with:
- massive HTML
- brittle selector scripts

---

## 8. Browser support strategy

### 8.1 First-class target
Chrome

### 8.2 Later targets
- Brave
- Chromium
- Edge

### 8.3 Compatibility strategy
Build the extension against Chrome APIs and Manifest V3.
Treat Chrome as the canonical runtime.
Other Chromium-based browsers are compatibility targets, not design drivers for v1.

---

## 9. Security and safety model

### 9.1 Safety baseline
Default mode must be read-only oriented.

### 9.2 Categories of actions

#### Safe read actions
- open tab
- focus tab
- navigate
- snapshot
- extract text
- screenshot
- scroll
- wait

#### Controlled interaction actions
- click
- type
- press key
- select option
- hover

#### Dangerous actions
- checkout
- buy now
- submit payment
- confirm order
- send irreversible form submission
- file upload
- access highly sensitive pages

Dangerous actions must be blocked by default in MVP.

### 9.3 Policy enforcement
Policy should be enforced in the Janus Browser Operator layer, not only in prompts.

Possible checks:
- block dangerous action text patterns
- block suspicious target URLs
- block interaction with payment-like button text
- optionally require explicit allowlist for sites or actions later

### 9.4 Dedicated profile requirement
The Janus browser profile must not contain:
- personal banking
- private email
- password manager
- private admin sessions
- unrelated personal accounts

### 9.5 Future safety upgrades
- explicit user confirmation gates
- action approval modes
- domain allowlists
- role-based execution modes
- record-and-replay audit trails

---

## 10. Snapshot model

### 10.1 Purpose
The snapshot is the core abstraction the agent uses to understand the page.

The goal is to expose:
- what matters
- what is visible
- what is interactive
- what can be acted on

without flooding the model with raw DOM noise.

### 10.2 Snapshot design goals
- compact
- semantic
- stable
- generic
- good enough for LLM planning
- easy to extend

### 10.3 What the snapshot should include per element
Recommended fields:

- id
- tag
- role
- text
- ariaLabel
- placeholder
- name
- type
- href
- value if relevant
- visible
- enabled
- interactive
- checked if relevant
- selected if relevant
- bounding box
- parent group hint or section hint if available
- semantic hints like product card or search field if inferable

### 10.4 Element ID format
Use stable page-local IDs such as:
- e1
- e2
- e3

Element IDs are valid only for the current snapshot version.

### 10.5 Snapshot scope
For MVP, include:
- visible interactive elements
- important visible text blocks
- links
- buttons
- inputs
- selects
- textareas
- product-like cards if inferable from repeated structures

Do not include:
- hidden nodes
- decorative wrappers
- most raw layout divs
- excessive nested spans unless they carry meaningful text

### 10.6 Snapshot invalidation rules
A snapshot becomes stale when:
- the page navigates
- a major DOM mutation occurs
- the user or agent changes page state substantially
- the extension reports content version drift

### 10.7 Future snapshot extensions
- grouped sections
- repeated collection detection
- product/list/table abstractions
- accessibility-tree-derived roles
- visual labels
- lightweight screenshot references

---

## 11. Action model

### 11.1 MVP actions

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

### 11.2 Optional v1.1 actions
- hover
- selectOption
- back
- forward
- reload

### 11.3 Action design rules
Every action should:
- have explicit input
- return structured output
- report errors consistently
- include request ID
- produce observable state changes if applicable

### 11.4 Example semantics

openTab
Creates a new tab and returns tab metadata.

navigate
Navigates a target tab to a URL and waits for a configurable condition.

snapshot
Returns a compact structured representation of the current page state.

click
Clicks a referenced element from the latest valid snapshot.

type
Focuses an input-like element and types text.

pressKey
Sends key events such as Enter, Escape, ArrowDown.

scroll
Scrolls by a delta or to a target position.

waitFor
Waits for conditions such as:
- URL match
- element exists
- text appears
- DOM stable

extractText
Returns visible text or filtered text based on snapshot references or heuristics.

screenshot
Captures the current tab view or visible area.

---

## 12. Wait and stability model

### 12.1 Why this matters
Most flaky browser systems fail not because click or type is hard, but because timing and page-state verification are weak.

### 12.2 MVP wait conditions
Implement at least:

- fixed short wait for debugging only
- urlMatches
- elementExists
- textAppears
- domStable

### 12.3 domStable definition
A practical MVP version:
- no major DOM mutation for N milliseconds
- document ready state complete or interactive plus stable mutation window

### 12.4 Future wait conditions
- network quiet
- repeated collection stable
- element visible and enabled
- page hash stabilization
- custom page predicate

### 12.5 Action verification
After key actions, verify outcome where possible.

Examples:
- after click, detect URL or DOM change
- after type, verify element value changed
- after navigation, verify page actually loaded
- after search, verify result content appeared

---

## 13. Error model

### 13.1 Error categories
- transport error
- tab not found
- element not found
- stale snapshot
- action blocked by policy
- timeout
- page changed unexpectedly
- unsupported action
- extension unavailable
- browser unavailable

### 13.2 Error response structure
Recommended fields:
- code
- message
- details
- requestId
- recoverable boolean
- suggestedNextStep optional

### 13.3 Recovery guidance
Examples:
- staleSnapshot -> request a new snapshot
- elementNotFound -> resnapshot and retry planning
- timeout -> try different wait condition
- blockedByPolicy -> stop or escalate
- transportDisconnected -> reconnect extension

---

## 14. Data model and protocol

### 14.1 Protocol goals
- simple
- typed
- stable
- transport-agnostic
- easy to debug

### 14.2 Recommended message shape

Command:
- requestId
- sessionId optional
- command
- payload

Response:
- requestId
- ok
- result or error
- pageState optional

Event:
- eventType
- payload
- timestamp

### 14.3 Suggested command names
- openTab
- focusTab
- navigate
- getCurrentUrl
- snapshot
- click
- type
- pressKey
- scroll
- waitFor
- extractText
- screenshot
- closeTab
- ping

### 14.4 Page state metadata
Useful response metadata:
- url
- title
- tabId
- snapshotVersion
- timestamp
- pageHash optional
- domain
- loadingState

---

## 15. Repository and code organization

We want something clean, but not overengineered.

### 15.1 Recommended MVP repository structure

chrome-extension/
- manifest.json
- src/background.ts
- src/content.ts
- src/types.ts
- src/snapshot.ts
- src/actions.ts
- src/runtime.ts

janus/
- src/tools/browser-operator.ts
- src/tools/browser-types.ts
- src/tools/browser-policy.ts
- src/tools/browser-protocol.ts
- src/tools/browser-session.ts

docs/
- janus-browser-operator-plan.md
- protocol.md optional later

### 15.2 Why this structure
This gives separation without premature packages.
Later, if needed, common types can move into shared packages.

### 15.3 Future extraction candidates
Only after real usage:
- shared protocol package
- snapshot utilities package
- policy package
- browser-domain-pack package

---

## 16. Phased roadmap

### Phase 0: design and setup
Goal:
Establish architecture, protocol, extension skeleton, and dedicated browser profile conventions.

Deliverables:
- final planning document
- protocol draft
- repository skeleton
- dedicated Chrome profile plan
- local dev startup approach

Acceptance:
- architecture is agreed
- folder structure exists
- browser profile strategy is defined

### Phase 1: runtime foundation
Goal:
Get Janus talking to the extension reliably.

Build:
- extension manifest
- background service worker
- transport connection from extension to Janus
- simple ping command
- tab discovery basics

Acceptance:
- extension connects successfully
- Janus can send and receive protocol messages
- active tab metadata can be read

### Phase 1.5: runtime hardening
Goal:
Production-grade resilience and runtime stability after Phase 1 foundation.

Important: We **do not adopt a CDP proxy model**. Janus remains **snapshot-centric and AI-native**.

#### Design principles (unchanged)
1. Public interface remains **one tool**: `browser({ command, args })`
2. Agent API remains **high-level**, not CDP level.
3. Browser control remains **snapshot-centric**.
4. Dangerous actions remain **policy-gated**.
5. Chrome runs using a **dedicated Janus profile**.
6. Extension connects to Janus (not the other way around).

#### P0 upgrades (immediate)

**WebSocket reconnect with exponential backoff**
MV3 service workers are restarted unpredictably. Extension must automatically reconnect.

Reconnect algorithm:
- initialDelay = 1000ms
- multiplier = 2
- maxDelay = 30000ms
- jitter = ±20%

Example sequence: 1s → 2s → 4s → 8s → 16s → 30s (cap).

**Extension reconnect grace period**
Janus must not immediately kill the session when the extension disconnects.

- extensionReconnectGraceMs = 20000
- If extension disconnects: state → disconnected_temporarily
- If extension reconnects before grace period: session continues
- If not: runtime transitions to `failed`

**Capability negotiation in handshake**

Extension → hello:
- protocolVersion, extensionVersion, browser info (name, version, userAgent)
- capabilities: ping, snapshot, click, type, scroll, pressKey, waitFor, screenshot, tabManagement

Janus → welcome:
- sessionId, acceptedProtocolVersion, policyMode
- snapshotConfig: viewportOnly, maxElements, maxGroups
- enabledCapabilities

**Runtime state machine**
Explicit states in browser-runtime.ts:
- idle → starting_ws → launching_browser → waiting_for_extension → ready → disconnected_temporarily → failed

**Health timeouts**
- launchTimeoutMs = 15000
- handshakeTimeoutMs = 10000
- commandTimeoutMs = 10000
- reconnectGraceMs = 20000

#### P1 upgrades (recommended next)

**Persistent extension state**
Use chrome.storage.session to persist: sessionId, active controlled tabs, last handshake metadata, connection status, policy mode.
Do NOT persist: full snapshots, large DOM blobs, screenshots.

**Tab/target lifecycle store**
Janus maintains tab metadata: tabId, url, title, active, controlled, status (discovered → controlled → active → stale → closed), lastSeenAt, snapshotVersion.

**Status command**
`browser({ command: "status" })` returns: wsServerRunning, chromeLaunched, extensionConnected, lastHandshakeAt, activeSessionId, activeTabCount, browserName, browserVersion, profilePath, policyMode.

#### P2 optional improvements

- Re-announce tabs after reconnect (tabs_announce message)
- Diagnostics metadata: requiresUserAttention, truncationApplied, captchaDetected, modalDetected
- Internal low-level substrate (hidden from public agent API)

#### Explicitly out of scope
- full CDP proxy
- external relay server
- exposing Runtime.evaluate to agent
- exposing DOM.querySelector to agent
- personal browser session as default

#### Phase 1.5 implementation checklist
1. WS reconnect with exponential backoff
2. extensionReconnectGraceMs handling
3. capability negotiation in handshake
4. runtime state machine
5. health timeouts
6. chrome.storage.session persistence
7. tab lifecycle store
8. browser.status command

#### Expected result
After Phase 1.5 the runtime has: resilient extension reconnect, protocol versioning, runtime lifecycle control, persistent session recovery, tab lifecycle management, diagnostic tooling.

---

### Phase 2: snapshot engine
Goal:
Give Janus a useful model of the page.

Build:
- content script DOM scanner
- visible interactive elements extraction
- element ID assignment
- snapshot response structure
- stale snapshot detection basics

Acceptance:
- Janus can request a snapshot
- snapshot contains usable references for visible controls
- Janus can identify search fields, links, and buttons on common sites

### Phase 3: core actions
Goal:
Enable basic browser interactions.

Build:
- navigate
- click
- type
- pressKey
- scroll
- getCurrentUrl
- closeTab

Acceptance:
- Janus can open a site, search, click results, and move through pages

### Phase 4: waits and stability
Goal:
Make interactions reliable.

Build:
- elementExists wait
- urlMatches wait
- domStable wait
- textAppears wait
- post-action verification

Acceptance:
- search flows do not depend on arbitrary sleeps
- retries happen only when justified

### Phase 5: screenshots and debugging
Goal:
Improve observability and diagnosis.

Build:
- screenshot command
- request/response logging
- action trace logs
- optional debug overlay for element refs later

Acceptance:
- Janus can capture evidence of page state
- failures are diagnosable

### Phase 6: policy and safety hardening
Goal:
Prevent dangerous behavior by default.

Build:
- action blocklist patterns
- dangerous text detection
- domain-sensitive restrictions
- read-only default execution mode

Acceptance:
- checkout and payment-like actions are blocked by default
- unsafe workflows fail safely

### Phase 7: generic browser workflows
Goal:
Use the operator on arbitrary websites, not just one marketplace.

Build:
- reusable planning prompts or tool docs for browser operation
- generic result extraction heuristics
- repeated-item detection improvements
- section/group identification

Acceptance:
- Janus can navigate and extract useful structured info from multiple classes of sites:
  - marketplaces
  - search engines
  - store sites
  - forms
  - dashboards

### Phase 8: domain packs / helpers (not yet started)

Status: **informational only — no code yet**

Goal:
Add optional domain helpers that improve agent performance on common website patterns. The browser operator must remain fully functional without Phase 8. This phase is only an optimization layer.

Design principles:
1. Domain helpers must remain optional.
2. The agent must be able to do everything using snapshot + actions alone.
3. Helpers should never hide the browser model from the agent.
4. Helpers should simplify common extraction tasks, not replace reasoning.

#### Shopping helpers

Possible utilities:
- extractOffers(snapshot) — find product cards, group title + price + link
- normalizePrice(text) — parse "49,99 zł" → { value: 49.99, currency: "PLN" }
- groupProducts(snapshot) — cluster elements by proximity or shared container
- compareOffers(offers) — sort by total price (product + shipping)

Target sites: Allegro, Amazon, eBay, Ceneo, store fronts.

#### Article / knowledge helpers

Possible utilities:
- extractArticleContent(snapshot) — main content block extraction
- extractHeadings(snapshot) — page outline from heading elements
- summarizePage(snapshot) — compact page summary for LLM context

Target sites: Wikipedia, blogs, documentation, news articles.

#### Search result helpers

Possible utilities:
- extractSearchResults(snapshot) — structured result list with title + url + snippet
- rankSearchResults(results) — relevance ordering

Target sites: Google, DuckDuckGo, Bing, site-internal search.

#### Non-goals for Phase 8

Do NOT:
- introduce site-specific scraping logic
- hardcode marketplace APIs
- bypass the snapshot model
- introduce CDP-level automation

Phase 8 should remain lightweight, generic, and optional.

#### When Phase 8 should begin

Phase 8 should start only after:
1. The browser operator works reliably on real websites.
2. Several real tasks have been tested (shopping, search, article reading).
3. We observe repeated patterns where helper utilities would improve agent performance.

Acceptance:
- core stays generic
- domain helpers are optional layers
- agent works equally well without helpers loaded

---

## 17. MVP definition

### 17.1 MVP statement
MVP is complete when Janus can safely operate a real Chrome tab through the extension using structured snapshots and core actions, on arbitrary websites, without relying on site-specific hardcoded workflows.

### 17.2 MVP capabilities
Required:
- connect Janus to extension
- request structured snapshot
- click
- type
- pressKey
- scroll
- navigate
- waitFor basic conditions
- screenshot
- basic safety policy

### 17.3 MVP acceptance scenarios

Scenario A: generic search
- open Google
- search a query
- navigate results
- open a result
- extract visible text

Scenario B: marketplace search
- open Allegro or eBay or Amazon
- search a product
- read visible product titles and prices from the results page
- return them to Janus

Scenario C: simple form
- open a basic non-sensitive form
- fill text fields
- navigate fields
- stop before dangerous submission if policy says so

### 17.4 MVP is not
- full shopping automation
- buying engine
- cloud browser platform
- universal anti-bot bypass system

---

## 18. Extensibility strategy

### 18.1 Keep the core generic
The operator should remain a general-purpose browser control layer.

### 18.2 Add capabilities as optional layers
Do not hardcode domain logic into the extension.
Instead, layer domain helpers in Janus tooling.

Examples:
- shopping list extraction
- product comparison
- form autofill strategies
- repeated card extraction
- search result ranking

### 18.3 Stable extension, evolving higher layers
The extension should mostly provide:
- page observation
- action execution
- state capture

Higher-level intelligence belongs in Janus.

### 18.4 Future architecture growth path
Possible later growth:
- local bridge process if needed
- remote browser support
- multi-tab orchestration
- action approvals
- reusable site heuristics
- richer extraction and grouping
- browser compatibility layer

---

## 19. Practical implementation order

### Step 1
Create dedicated Chrome profile conventions and local dev setup.
Decide how Janus starts or attaches to Chrome.

### Step 2
Implement extension skeleton:
- manifest
- background
- content script injection model
- transport connection

### Step 3
Implement protocol types and ping flow.

### Step 4
Implement snapshot v1:
- visible interactive elements
- basic visible text items
- element references

### Step 5
Implement action v1:
- click
- type
- pressKey
- scroll
- navigate

### Step 6
Implement waitFor v1:
- urlMatches
- elementExists
- domStable
- textAppears

### Step 7
Implement screenshot support and logging.

### Step 8
Implement policy v1:
- read-only default
- dangerous action blocks
- denylist text patterns

### Step 9
Write Janus-side tool prompt or usage guidance so the agent knows:
- when to resnapshot
- when to wait
- how to recover from stale elements
- how to keep action counts small

### Step 10
Test against multiple site classes:
- Google
- Allegro
- eBay
- Amazon
- a simple form site

---

## 20. Test strategy

### 20.1 Test categories
- unit tests for protocol and policy logic
- snapshot tests on synthetic pages
- integration tests against local test pages
- manual real-site smoke tests
- regression tests for action semantics

### 20.2 Recommended test pages
Use a mix of:
- controlled local test pages
- simple public pages
- dynamic real websites
- e-commerce search pages

### 20.3 Real-world smoke tests
At minimum:
- Google search flow
- Allegro product search flow
- eBay result navigation flow
- Amazon search flow
- basic form filling flow

### 20.4 Debug tools
Useful dev features:
- snapshot dump
- request logs
- response logs
- screenshot on failure
- optional temporary debug overlay

---

## 21. Observability and diagnostics

### 21.1 What to log
- connection status
- command sent
- response received
- action duration
- wait durations
- error category
- current URL
- snapshot version

### 21.2 Failure evidence
On important failures, capture:
- screenshot
- current URL
- error code
- page title
- last snapshot summary

### 21.3 Future diagnostics
- action timeline viewer
- session replay
- debug command console

---

## 22. Performance considerations

### 22.1 Keep snapshots compact
Avoid giant DOM payloads.

### 22.2 Keep action loops small
The agent should not blindly click around.
Prefer:
- snapshot
- reason
- act
- verify
- resnapshot if needed

### 22.3 Avoid too many tabs
Use focused workflows.

### 22.4 Reuse the same dedicated profile
This improves practical stability more than over-optimizing action speed.

---

## 23. Risks and mitigation

### Risk 1: snapshot too noisy
Mitigation:
- aggressive filtering
- semantic element prioritization
- iterative refinement

### Risk 2: action flakiness
Mitigation:
- proper waits
- post-action verification
- stale snapshot handling

### Risk 3: policy gaps
Mitigation:
- deny dangerous actions by default
- keep read-only as baseline
- audit command surface

### Risk 4: overengineering too early
Mitigation:
- phased implementation
- minimal runtime for MVP
- full architecture in docs, minimal implementation in code

### Risk 5: underengineering leading to future mess
Mitigation:
- define architecture clearly now
- separate core operator from domain-specific logic
- use typed protocol from day one

---

## 24. Final recommended implementation stance

### What to do now
Build:
- Chrome-first
- dedicated profile
- extension-driven real browser control
- direct Janus-to-extension transport
- generic operator
- snapshot + actions + wait + screenshot + safety

### What not to do now
Do not build:
- separate local daemon unless needed
- marketplace-specific workflows in the core
- remote browser infrastructure
- massive package architecture
- full browser-automation framework clone

### What to preserve from day one
Preserve:
- clean abstractions
- typed protocol
- snapshot-centered design
- safety-first execution model
- generic extensibility path

---

## 25. Definition of done for v1 foundation

The v1 foundation is done when all of the following are true:

1. Janus can connect to the extension running in a dedicated Chrome profile.
2. Janus can request a valid page snapshot.
3. Janus can execute click, type, pressKey, scroll, navigate, waitFor, and screenshot.
4. Snapshot references are stable within a page state and properly invalidated when stale.
5. Dangerous actions are blocked by policy.
6. Janus can complete a generic search and extract visible results on multiple real websites.
7. The implementation is still generic and not polluted by site-specific hacks.
8. The codebase structure remains clean enough to extend with domain packs later.

---

## 26. Suggested immediate next actions

1. Freeze this plan as the baseline design document.
2. Create the repository folders and placeholder files.
3. Define the protocol types first.
4. Implement extension transport and ping.
5. Implement snapshot v1 before trying to script any real workflow.
6. Implement click and type only after snapshot is usable.
7. Add waitFor before broad real-site testing.
8. Add screenshot and logs before debugging complex sites.
9. Add policy before scaling agent autonomy.
10. Only after that start broader website validation and future domain packs.

---

## 27. Short conclusion

We are building a generic real-browser operator for Janus, not a marketplace scraper and not a clone of existing automation frameworks.

The key decisions are:

- real Chrome profile instead of headless automation
- dedicated browser profile instead of personal browsing profile
- structured snapshots instead of selectors as the agent interface
- constrained action model instead of arbitrary browser control
- safety-first execution
- full design now, phased implementation later

This gives us a stable foundation that can start small and grow into a general-purpose browser capability for Janus across marketplaces, search engines, forms, and other websites.

