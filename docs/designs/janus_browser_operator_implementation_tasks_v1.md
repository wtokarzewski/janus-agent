
# Janus Browser Operator
## Implementation Tasks Plan (v1)

Purpose:
This document translates the architecture plan into a concrete, step‑by‑step
implementation roadmap. It is intended to guide development from an empty
repository to a stable v1 browser operator foundation.

The architecture document defines *what* we are building.
This document defines *how we implement it step by step.*

The goal is to move from zero → working system without architectural shortcuts.

---------------------------------------------------------------------
SECTION 1 — PROJECT PRINCIPLES
---------------------------------------------------------------------

Development rules:

1. Implement in small vertical slices.
2. Each phase must produce something testable.
3. Never implement browser actions before snapshot is stable.
4. Never automate a workflow before core primitives work.
5. Avoid premature abstractions.
6. Prefer simple code paths over clever code.
7. Maintain strict typing in protocol structures.

Every phase ends with **Acceptance Criteria**.

---------------------------------------------------------------------
SECTION 2 — REPOSITORY INITIALIZATION
---------------------------------------------------------------------

Objective:
Create a clean repository structure that matches the architecture plan.

Tasks:

1. Create repository folders

chrome-extension/
janus/
docs/

2. Inside chrome-extension:

manifest.json
src/background.ts
src/content.ts
src/snapshot.ts
src/actions.ts
src/runtime.ts
src/types.ts

3. Inside janus:

src/tools/browser-operator.ts
src/tools/browser-protocol.ts
src/tools/browser-types.ts
src/tools/browser-policy.ts
src/tools/browser-session.ts

4. Add development configuration

package.json
tsconfig.json
eslint config
basic build script

5. Add documentation

docs/janus-browser-operator-plan.md
docs/browser-operator-tasks.md

Acceptance Criteria:

Repository compiles without errors.
Extension can be built.
Janus code compiles independently.

---------------------------------------------------------------------
SECTION 3 — DEDICATED CHROME PROFILE SETUP
---------------------------------------------------------------------

Objective:
Ensure Janus runs inside a dedicated Chrome profile.

Tasks:

1. Define profile name:

janus-browser

2. Document launch command:

chrome --user-data-dir=/path/to/janus-profile

3. Document extension loading in dev mode.

4. Ensure profile persistence across sessions.

Acceptance Criteria:

Chrome launches with clean Janus profile.
Extension can be installed and persists.

---------------------------------------------------------------------
SECTION 4 — TRANSPORT LAYER
---------------------------------------------------------------------

Objective:
Establish reliable communication between Janus and the extension.

Tasks:

1. Implement WebSocket client inside extension background script.

2. Implement WebSocket server inside Janus runtime.

3. Define message format:

requestId
command
payload

4. Define response format:

requestId
ok
result or error

5. Implement ping command.

6. Implement connection retry.

Acceptance Criteria:

Janus can send a ping command.
Extension returns pong.
Connection survives page navigation.

---------------------------------------------------------------------
SECTION 5 — TAB MANAGEMENT
---------------------------------------------------------------------

Objective:
Allow Janus to inspect and control browser tabs.

Tasks:

1. Implement getActiveTab.

2. Implement openTab.

3. Implement focusTab.

4. Implement closeTab.

5. Return tab metadata:

tabId
url
title

Acceptance Criteria:

Janus can open a tab.
Janus can focus it.
Janus can close it.

---------------------------------------------------------------------
SECTION 6 — SNAPSHOT ENGINE (CORE)
---------------------------------------------------------------------

Objective:
Expose page structure to the agent.

This is the most critical subsystem.

Tasks:

1. Implement DOM scan function.

2. Filter visible nodes.

3. Detect interactive elements:

links
buttons
inputs
selects
textareas

4. Extract element metadata:

text
ariaLabel
placeholder
name
type
href

5. Assign element IDs:

e1
e2
e3

6. Return structured snapshot object.

7. Limit snapshot size.

Acceptance Criteria:

Snapshot contains usable element references.
Search field and buttons appear correctly.
Snapshot size stays reasonable.

---------------------------------------------------------------------
SECTION 7 — SNAPSHOT STABILITY
---------------------------------------------------------------------

Objective:
Prevent stale element references.

Tasks:

1. Implement snapshotVersion.

2. Detect DOM mutations.

3. Invalidate snapshot on navigation.

4. Reject actions using stale snapshots.

Acceptance Criteria:

Agent cannot click stale element references.
Snapshot refresh works reliably.

---------------------------------------------------------------------
SECTION 8 — CORE ACTIONS
---------------------------------------------------------------------

Objective:
Enable real page interactions.

Actions to implement:

click
type
pressKey
scroll
navigate

Tasks:

1. Implement click(elementId).

2. Implement type(elementId, text).

3. Implement pressKey(key).

4. Implement scroll(delta).

5. Implement navigate(url).

Acceptance Criteria:

Agent can search on Google.
Agent can click result links.
Agent can navigate between pages.

---------------------------------------------------------------------
SECTION 9 — WAIT SYSTEM
---------------------------------------------------------------------

Objective:
Ensure stable automation.

Tasks:

1. Implement waitForUrlMatch.

2. Implement waitForElement.

3. Implement waitForText.

4. Implement domStable wait.

Acceptance Criteria:

Agent can wait for search results before acting.
No reliance on fixed sleeps.

---------------------------------------------------------------------
SECTION 10 — SCREENSHOT SUPPORT
---------------------------------------------------------------------

Objective:
Improve debugging and visibility.

Tasks:

1. Implement screenshot command.

2. Capture visible viewport.

3. Return base64 encoded image.

Acceptance Criteria:

Agent can request screenshot.
Screenshot matches current page.

---------------------------------------------------------------------
SECTION 11 — SAFETY POLICY
---------------------------------------------------------------------

Objective:
Prevent dangerous actions.

Tasks:

1. Define dangerous text patterns:

buy now
checkout
place order
confirm purchase

2. Block interactions with matching elements.

3. Add policy enforcement layer in Janus.

Acceptance Criteria:

Agent cannot click checkout buttons.
Dangerous actions return policy error.

---------------------------------------------------------------------
SECTION 12 — ERROR HANDLING
---------------------------------------------------------------------

Objective:
Provide predictable failures.

Tasks:

Define error codes:

transport_error
tab_not_found
element_not_found
stale_snapshot
timeout
policy_blocked

Implement structured error responses.

Acceptance Criteria:

Errors are typed and recoverable.

---------------------------------------------------------------------
SECTION 13 — LOGGING AND DEBUGGING
---------------------------------------------------------------------

Objective:
Enable debugging of browser sessions.

Tasks:

Log commands sent.
Log responses received.
Log action duration.
Log errors.

Acceptance Criteria:

Logs allow replay of agent decisions.

---------------------------------------------------------------------
SECTION 14 — CROSS-SITE TESTING
---------------------------------------------------------------------

Objective:
Verify operator works on real websites.

Test Sites:

Google
Allegro
eBay
Amazon

Test Scenarios:

search for product
open result
extract visible information

Acceptance Criteria:

Agent completes tasks without manual selectors.

---------------------------------------------------------------------
SECTION 15 — MVP ACCEPTANCE
---------------------------------------------------------------------

MVP is complete when:

Janus connects to extension.
Snapshot returns useful elements.
Agent can click, type, scroll.
Agent can navigate search results.
Safety policy blocks dangerous actions.
System works on multiple real websites.

---------------------------------------------------------------------
SECTION 16 — POST-MVP EXPANSION
---------------------------------------------------------------------

Future work may include:

visual debugging overlay
domain-specific extraction helpers
advanced snapshot grouping
multi-tab orchestration
remote browser support
session replay

These features must remain outside the core operator.

