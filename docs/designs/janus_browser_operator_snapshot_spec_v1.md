# Janus Browser Operator
## Snapshot Specification v1
## LLM-Optimized Page Representation

Version: v1
Status: Recommended baseline specification
Purpose: define the best current snapshot model for Janus Browser Operator so the agent can reason about real web pages reliably, safely, and efficiently.

---

## 1. Why this document exists

The snapshot is the single most important artifact in the browser operator.

If the snapshot is too noisy:
- the model gets confused
- token usage explodes
- planning quality drops

If the snapshot is too small:
- the model misses important controls
- actions fail
- workflows become brittle

If the snapshot is unstable:
- element references become unreliable
- retries increase
- the agent starts making poor decisions

This document defines a practical, extensible snapshot design that is optimized for LLM reasoning, not for generic DOM serialization.

The goal is not to mirror the full page.
The goal is to represent the page in the most decision-useful way possible.

---

## 2. Design goals

The snapshot must be:

1. Compact
2. Semantic
3. Stable
4. Generic
5. Deterministic enough for actions
6. Extensible without breaking the protocol
7. Good for multi-step reasoning
8. Good for dynamic modern websites

---

## 3. Core philosophy

The model should not reason over raw HTML.

The model should reason over a structured page map made of:
- page metadata
- current state
- visible actionable elements
- important visible content
- grouped repeated structures when possible
- light semantic hints

The snapshot should act like a condensed UI map.

The browser operator should expose:
- what the user can currently see
- what the agent can safely act on
- what content matters for the task
- what changed since the last interaction

---

## 4. Snapshot layers

The best snapshot is layered.

### Layer A: Page metadata
What page are we on?
What is the page state?

### Layer B: Actionable elements
What can I click, type into, select, or otherwise interact with?

### Layer C: Important visible content
What visible text blocks or structured result items matter?

### Layer D: Structural groups
Which elements belong together as result cards, forms, tables, nav sections, product lists, etc.?

### Layer E: Lightweight semantic hints
What is this page likely about?
Search page?
Product page?
Form page?
Listing page?
Dialog open?
Captcha visible?

Not all layers need to be equally rich in v1, but the design should support all of them.

---

## 5. What the snapshot should NOT be

Do not make the snapshot:
- a full DOM dump
- a raw innerText dump of the whole page
- a CSS selector list
- a pixel-coordinate map as the main interface
- a giant accessibility tree dump
- a screenshot-only representation

Those are either too noisy, too brittle, or too expensive.

---

## 6. Recommended top-level snapshot structure

Recommended top-level object:

- snapshotVersion
- page
- state
- elements
- groups
- diagnostics

Example shape:

{
  "snapshotVersion": 7,
  "page": { ... },
  "state": { ... },
  "elements": [ ... ],
  "groups": [ ... ],
  "diagnostics": { ... }
}

This gives a stable root shape that can be extended later.

---

## 7. Top-level field specification

### 7.1 snapshotVersion
Type: number

Meaning:
Monotonic snapshot counter for the current tab state.

Rules:
- increment on every fresh snapshot generation
- invalidate older element refs when the snapshotVersion changes materially

### 7.1a schemaVersion
Type: number

Meaning:
Schema version for the snapshot structure itself.
Allows future schema evolution without breaking consumers.

Example: `{ snapshotVersion: 7, schemaVersion: 1 }`

snapshotVersion tracks per-page snapshot generation count.
schemaVersion tracks the snapshot format version.

### 7.2 page
Type: object

Recommended fields:
- url
- domain
- title
- language optional
- viewport
- timestamp
- tabId optional
- pageTypeHints

### 7.3 state
Type: object

Recommended fields:
- readyState
- loadingState
- dialogOpen
- modalOpen
- captchaVisible
- requiresUserAttention
- pageHash optional
- staleAfterAction boolean optional

### 7.4 elements
Type: array of element objects

Meaning:
The main list of visible actionable or highly relevant visible items.

### 7.5 groups
Type: array of group objects

Meaning:
Optional structured clusters like search results, product cards, tables, form sections, nav menus.

### 7.6 diagnostics
Type: object

Meaning:
Useful for debugging and observability, not always required for the model.

Possible fields:
- totalVisibleNodesScanned
- totalElementsReturned
- truncationApplied
- warnings

---

## 8. Page metadata model

Recommended page object:

{
  "url": "https://allegro.pl/listing?string=lavazza",
  "domain": "allegro.pl",
  "title": "lavazza - Allegro",
  "language": "pl",
  "viewport": {
    "width": 1440,
    "height": 900,
    "scrollX": 0,
    "scrollY": 742
  },
  "timestamp": "2026-03-15T10:30:00Z",
  "pageTypeHints": [
    "search_results",
    "marketplace",
    "listing_page"
  ]
}

### Why pageTypeHints matter
These are not hard guarantees.
They are lightweight hints that improve LLM planning.

Possible values:
- home_page
- search_results
- product_page
- article_page
- form_page
- login_page
- cart_page
- checkout_page
- modal_overlay
- captcha_page
- dashboard
- marketplace
- search_engine
- store_front

These hints should be heuristic and non-blocking.

---

## 9. State model

Recommended state object:

{
  "readyState": "complete",
  "loadingState": "stable",
  "dialogOpen": false,
  "modalOpen": false,
  "captchaVisible": false,
  "requiresUserAttention": false
}

### loadingState recommended values
- loading
- interactive
- stable
- changing

### requiresUserAttention
Use this when the page shows:
- CAPTCHA
- permission prompt
- cookie wall blocking main content
- login gate
- anti-bot challenge
- fatal page error

This is very important because it lets Janus stop planning nonsense on blocked pages.

---

## 10. Element model

This is the most important object in the snapshot.

Recommended element object:

{
  "id": "e12",
  "kind": "actionable",
  "tag": "input",
  "role": "textbox",
  "text": "",
  "accessibleName": "Search",
  "placeholder": "Search",
  "name": "q",
  "type": "text",
  "href": null,
  "valuePreview": "",
  "visible": true,
  "enabled": true,
  "interactive": true,
  "checked": null,
  "selected": null,
  "bbox": {
    "x": 120,
    "y": 48,
    "width": 420,
    "height": 36
  },
  "groupId": "g1",
  "semanticHints": [
    "search_input"
  ]
}

---

## 11. Required element fields

These should exist in every element object, even if null.

- id
- kind
- tag
- role
- text
- accessibleName
- placeholder
- name
- type
- href
- valuePreview
- visible
- enabled
- interactive
- checked
- selected
- bbox
- groupId
- semanticHints

This consistency matters a lot for LLM reasoning.

---

## 12. Element field details

### 12.1 id
Type: string
Example: e1, e2, e3

Rules:
- unique within snapshot
- stable within that snapshot
- never reused inside one snapshot

### 12.2 kind
Type: string

Recommended values:
- actionable
- content
- input
- navigation
- result_item
- warning
- status

This is a high-level classification, not DOM truth.

### 12.3 tag
Type: string
Examples:
- a
- button
- input
- select
- textarea
- div

### 12.4 role
Type: string or null
Prefer ARIA/computed interaction role if available.

Examples:
- link
- button
- textbox
- checkbox
- radio
- combobox
- dialog
- heading
- listitem

### 12.5 text
Type: string
Meaning:
Visible normalized text directly associated with this element.

Keep it short.
Trim whitespace.
Collapse repeated spaces.

### 12.6 accessibleName
Type: string or null
Meaning:
Best user-facing label derived from:
- aria-label
- aria-labelledby
- associated label
- element text
- title attribute
- other accessible naming sources

This is usually more useful than raw text.

### 12.7 placeholder
Type: string or null
Useful for inputs.

### 12.8 name
Type: string or null
Useful for forms and search fields.

### 12.9 type
Type: string or null
Examples:
- text
- search
- email
- password
- submit
- checkbox

### 12.10 href
Type: string or null
Only for link-like elements where relevant.

### 12.11 valuePreview
Type: string or null
For inputs or controls.
Do not dump large sensitive values.
Use a safe preview if needed.

### 12.12 visible
Type: boolean
True only if meaningfully visible to the user.

### 12.13 enabled
Type: boolean or null
Important for action planning.

### 12.14 interactive
Type: boolean
The single most important planning field.
If false, the agent should generally not click or type here.

### 12.15 checked
Type: boolean or null
For checkbox/radio.

### 12.16 selected
Type: boolean or null
For selected options or tabs.

### 12.17 bbox
Type: object or null
Fields:
- x
- y
- width
- height

Why keep it:
- useful for ordering
- useful for debugging
- useful for grouping
- useful for future overlays

### 12.18 groupId
Type: string or null
Ties element to a higher-level group like a product card or form section.

### 12.19 semanticHints
Type: array of strings
Examples:
- search_input
- primary_cta
- pagination_link
- product_title
- product_price
- filter_control
- nav_item
- cookie_accept
- close_dialog
- result_link

These hints should remain heuristic, not magical.

---

## 13. Group model

Groups are extremely valuable and worth supporting from early on.

Recommended group object:

{
  "id": "g3",
  "kind": "result_card",
  "label": "Product result 1",
  "elementIds": ["e21", "e22", "e23"],
  "semanticHints": [
    "product_card"
  ]
}

### Why groups matter
Without groups, the model sees:
- title
- price
- shipping
- rating
- link

as disconnected items.

With groups, the model sees:
This title and this price belong to the same result.

This is crucial for:
- shopping
- search results
- forms
- dashboards
- comparison tables

### Recommended group kinds
- result_card
- product_card
- search_result
- form_section
- nav_section
- dialog
- table_row
- filter_panel
- pagination
- header
- footer

---

## 14. Ordering rules

Ordering is critical.

The snapshot should be sorted primarily in user-perceived reading order:
- top to bottom
- left to right

Groups should also preserve this order.

Why:
LLMs reason much better when the page map resembles what a human sees.

Bad order:
DOM order mixed with hidden nodes and detached overlays

Good order:
visual order of visible elements

---

## 15. Inclusion rules

### Include
- visible buttons
- visible links
- visible inputs
- visible selects
- visible textareas
- clickable divs with real interaction semantics
- important headings or labels if they explain the UI
- repeated result items and their important children
- warning banners
- cookie walls if blocking
- dialog controls
- pagination controls

### Exclude
- hidden nodes
- style/script
- invisible wrappers
- decorative icons unless they are the only label
- deeply duplicated nested text
- raw repeated spans with no separate meaning
- tiny fragments with no action or content value

---

## 16. Compression and normalization rules

### Text normalization
- trim
- collapse whitespace
- remove excessive line breaks
- cap long text fields

### URL normalization
Keep hrefs but prefer same-page-safe values.
Do not include giant tracking parameter blobs if easily removable.

### Length limits
Reasonable recommended caps:
- text: 160 chars
- accessibleName: 120 chars
- placeholder: 120 chars
- valuePreview: 80 chars

For longer text:
- truncate with clear suffix
- never silently cut without indication

---

## 17. Semantic hint system

Semantic hints are a major quality multiplier if done carefully.

### Good semantic hints
- search_input
- search_button
- result_link
- product_title
- product_price
- add_to_cart
- filter_checkbox
- sort_dropdown
- pagination_next
- close_modal
- cookie_accept
- login_button
- captcha_challenge

### Bad semantic hints
Do not invent overconfident labels such as:
- definitely_best_result
- exact_main_product
- trusted_seller

Hints must describe likely UI function, not business truth.

---

## 18. Page-level heuristics worth adding

At page level, expose quick boolean flags or hints.

Examples:
- likelySearchResults
- likelyProductPage
- likelyFormPage
- hasPagination
- hasSearchInput
- hasModal
- hasCaptcha
- hasCookieBanner
- hasInfiniteScrollIndicators

These reduce unnecessary agent exploration.

---

## 19. Snapshot truncation strategy

Real pages can contain hundreds of visible elements.

Do not dump them all.

### Recommended strategy
Apply priority-based inclusion.

Priority order:
1. blocking UI and warnings
2. active dialog elements
3. visible actionable inputs/buttons/links
4. repeated result-item structures
5. important headings and labels
6. low-value content

### Recommended soft limits
- 80 to 150 elements for standard snapshot
- 20 to 50 groups
- if more content exists, return truncationApplied = true

### Default snapshot config (from snapshotConfig in welcome handshake)
- viewportOnly = true (elements outside viewport are excluded by default)
- maxElements = 100
- maxGroups = 25

These defaults are sent during the welcome handshake and can be adjusted per session.

### Optional future modes
- compact
- standard
- detailed
- focused-region

For v1, standard only is fine.

---

## 20. Best possible v1 snapshot shape

This is the recommended v1 baseline.

{
  "snapshotVersion": 4,
  "page": {
    "url": "https://www.google.com/search?q=lavazza+1kg",
    "domain": "google.com",
    "title": "lavazza 1kg - Google Search",
    "language": "en",
    "viewport": {
      "width": 1440,
      "height": 900,
      "scrollX": 0,
      "scrollY": 0
    },
    "timestamp": "2026-03-15T11:00:00Z",
    "pageTypeHints": [
      "search_results",
      "search_engine"
    ]
  },
  "state": {
    "readyState": "complete",
    "loadingState": "stable",
    "dialogOpen": false,
    "modalOpen": false,
    "captchaVisible": false,
    "requiresUserAttention": false
  },
  "elements": [
    {
      "id": "e1",
      "kind": "input",
      "tag": "textarea",
      "role": "textbox",
      "text": "",
      "accessibleName": "Search",
      "placeholder": null,
      "name": "q",
      "type": "search",
      "href": null,
      "valuePreview": "lavazza 1kg",
      "visible": true,
      "enabled": true,
      "interactive": true,
      "checked": null,
      "selected": null,
      "bbox": { "x": 180, "y": 120, "width": 560, "height": 42 },
      "groupId": null,
      "semanticHints": ["search_input"]
    },
    {
      "id": "e2",
      "kind": "result_item",
      "tag": "a",
      "role": "link",
      "text": "Lavazza Crema e Aroma 1kg",
      "accessibleName": "Lavazza Crema e Aroma 1kg",
      "placeholder": null,
      "name": null,
      "type": null,
      "href": "https://example.com/offer1",
      "valuePreview": null,
      "visible": true,
      "enabled": true,
      "interactive": true,
      "checked": null,
      "selected": null,
      "bbox": { "x": 120, "y": 240, "width": 640, "height": 22 },
      "groupId": "g1",
      "semanticHints": ["result_link", "product_title"]
    },
    {
      "id": "e3",
      "kind": "content",
      "tag": "span",
      "role": null,
      "text": "49.99 zl",
      "accessibleName": "49.99 zl",
      "placeholder": null,
      "name": null,
      "type": null,
      "href": null,
      "valuePreview": null,
      "visible": true,
      "enabled": null,
      "interactive": false,
      "checked": null,
      "selected": null,
      "bbox": { "x": 122, "y": 270, "width": 88, "height": 18 },
      "groupId": "g1",
      "semanticHints": ["product_price"]
    }
  ],
  "groups": [
    {
      "id": "g1",
      "kind": "search_result",
      "label": "Search result 1",
      "elementIds": ["e2", "e3"],
      "semanticHints": ["product_card"]
    }
  ],
  "diagnostics": {
    "totalVisibleNodesScanned": 642,
    "totalElementsReturned": 34,
    "truncationApplied": false,
    "warnings": []
  }
}

This shape is practical, generic, and expandable.

---

## 21. Recommended v1 algorithm for building the snapshot

### Step 1
Scan the live DOM and gather candidate visible nodes.

### Step 2
Filter out hidden, zero-size, offscreen-insignificant, or decorative nodes.

### Step 3
Classify candidate nodes:
- input-like
- click-like
- link-like
- content-like
- warning-like
- overlay-like

### Step 4
Compute semantic fields:
- text
- accessibleName
- placeholder
- role
- href
- type
- group hint
- semantic hints

### Step 5
Infer repeated structures and build groups when possible.

### Step 6
Sort elements in visual reading order.

### Step 7
Apply compression and truncation rules.

### Step 8
Return the final snapshot object with metadata and diagnostics.

---

## 22. Accessibility-derived data is useful but not sufficient

The accessibility tree is helpful for:
- roles
- names
- interactive semantics

But it should not be the only source.

Why:
- many sites have poor accessibility
- not all visible content appears cleanly there
- layout-based grouping still matters

Best approach:
Use accessibility data when available, but combine it with DOM and visibility heuristics.

---

## 23. Special cases the snapshot should surface early

These are high-value special cases.

### 23.1 CAPTCHA or challenge page
Set:
- captchaVisible = true
- requiresUserAttention = true
Add visible warning elements if possible.

### 23.2 Cookie wall
If a cookie banner blocks interaction:
- modalOpen = true or dialogOpen = true
- include its buttons prominently
- add semantic hints like cookie_accept or cookie_reject

### 23.3 Login gate
Surface:
- likely login form fields
- login/continue buttons
- requiresUserAttention when the page is blocked behind auth

### 23.4 Modal overlays
These must be prioritized, otherwise the agent will try to click blocked page content underneath.

### 23.5 Infinite scroll/listing page
Expose:
- hasPagination or likely infinite listing hints if possible
- visible result groups only, not entire feed history

---

## 24. Snapshot quality criteria

A good snapshot should let the agent answer:

1. What page am I on?
2. Is the page stable enough to act?
3. What are the main actionable controls?
4. What content is important for the current task?
5. Which title/price/button belong together?
6. Is there any blocking UI I must handle first?
7. Do I need a fresh snapshot before acting?

If the snapshot cannot answer those reliably, it is not good enough.

---

## 25. Snapshot anti-patterns

Avoid these common mistakes.

### Anti-pattern 1
Returning hundreds of raw clickable nodes with no grouping.

### Anti-pattern 2
Returning only inputs and buttons while excluding important content text.

### Anti-pattern 3
Using raw CSS selectors as the main agent API.

### Anti-pattern 4
Ignoring dialogs and overlays.

### Anti-pattern 5
Ordering by raw DOM rather than visual reading order.

### Anti-pattern 6
Returning giant text blobs instead of structured element objects.

### Anti-pattern 7
No snapshotVersion or stale reference rules.

---

## 25a. Password masking

Snapshots must never expose sensitive field values.

Fields of type "password" must return:
- valuePreview: null

Credit card fields and other sensitive inputs should also be masked.

---

## 25b. Performance target

Snapshot generation must complete within:
- <= 100 ms

Typical element count per snapshot:
- 40–80 elements

---

## 26. Recommended evolution path

### v1
- page metadata
- state
- visible elements
- basic groups
- semantic hints
- diagnostics

### v1.1
- better repeated item grouping
- dialog prioritization
- better form section grouping
- pagination hints

### v1.2
- focused snapshot modes
- richer result card inference
- table row grouping
- improved warning detection

### v2
- region snapshots
- element confidence scores
- richer accessibility fusion
- screenshot-linked debug references
- domain pack augmentation

---

## 27. Final recommendation

If you want the best current practical solution for Janus, the snapshot should be:

- structured, not raw
- semantic, not selector-centric
- grouped, not flat-only
- compact, not exhaustive
- ordered visually
- versioned
- safety-aware
- generic

The exact sweet spot for v1 is:

1. page metadata
2. page state
3. visible actionable elements
4. key visible content
5. lightweight groups
6. semantic hints
7. diagnostics

That combination gives the LLM enough signal to plan well, while keeping the system maintainable and extensible.

---

## 28. Immediate implementation recommendation

Build snapshot v1 in this order:

1. visible candidate detection
2. interactive classification
3. text and accessible name extraction
4. visual ordering
5. element ID assignment
6. group inference for repeated result cards
7. snapshotVersion and invalidation
8. diagnostics and truncation

Do not start with:
- advanced visual reasoning
- giant accessibility dumps
- screenshot-first logic
- domain-specific hardcoding

Get the core page map right first.

That is the highest leverage work in the whole browser operator.
