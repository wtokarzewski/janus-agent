# Architecture

## Overview

Janus is a universal AI agent built on a flat agent loop — the LLM decides what to do, tools execute actions, and the loop continues until done. No rigid pipeline, no pre-classification.

```
CLI/Telegram → MessageBus → AgentLoop → ProviderRegistry → Tools → Response
                                ↑              ↑               ↑
                          CronService        Database    spawn_agent → SubAgent
                          HeartbeatService (SQLite+FTS5)  Learner (metrics)
                                             + Vector
```

**Status (Phase 9):** ~13,200 LOC, 374 tests across 38 files, CI pipeline. See [FEATURES.md](../FEATURES.md) for full feature list.

## Core Pipeline

### 1. Channels → MessageBus

Channels produce `InboundMessage`, consume `OutboundMessage` via the bus.

- **CLI** (`src/channels/cli-channel.ts`) — interactive REPL
- **Telegram** (`src/channels/telegram-channel.ts`) — grammy bot
- **MCP** (`src/commands/mcp-server.ts`) — JSON-RPC over stdin/stdout for editor integration

### 2. AgentLoop (`src/agent/agent-loop.ts`)

Flat iteration loop:
1. Consume inbound → get/create session → build system prompt
2. LLM call (with streaming if enabled)
3. If tool_calls → execute each tool → append results → loop back to LLM
4. If no tool_calls → save response → publish outbound
5. Fire-and-forget: learner metrics, summarization (with memory flush)

Key behaviors:
- **Emergency compression** — on context overflow, drop oldest 50%, retry up to 2x
- **Token-based summarization** — when session tokens exceed 75% of budget, summarize
- **Memory flush** — before summarization, LLM extracts key facts → daily notes
- **No-op suppression** — heartbeat/cron "HEARTBEAT_OK" responses not routed to user
- **Subagent spawning** — `spawn_agent` tool creates child AgentLoop with minimal prompt

Lane and direct entry share a FIFO turn lock on the bus, keyed by the same full
session key used for history and steering. A session remains owned until its
turn settles, even after a watchdog releases the lane slot or five minutes pass.
Controllers are registered only after acquiring the lock. Other sessions remain
concurrent. DM identity links use channel identities (with legacy profile-ID
links retained); channel/topic/agent boundaries remain distinct. System jobs and
child sessions do not join a shared DM. Telegram steering uses the resolved
session identity rather than a bare chat ID. End-to-end provider/tool cancellation
and watchdog slot lifecycle remain follow-up work in JL-14.

Context routing, timeout recovery and background compaction thresholds use the
same request estimator: system text once, message framing, tool-call arguments
and IDs, tool definitions, text and image blocks. The response reserves the
request's configured `maxTokens`. The character ratio, fixed image allowance and
safety margin are heuristics, not an exact tokenizer or a guaranteed upper bound.
After a transform the loop checks the whole request again, tries one hard clear
of eligible old tool results, and stops with a budget message if it still cannot
fit. It preserves the input and does not repeatedly compact an unchanged request.
Provider-specific windows and legacy budget options remain separate follow-up work.

### 3. ContextBuilder (`src/context/context-builder.ts`)

Assembles system prompt from multiple sources:

| # | Section | Source | Minimal mode |
|---|---------|--------|-------------|
| 1 | Identity | Built-in (timestamp, workspace, available tools) | ✅ |
| 2 | User profile | Per-user PROFILE.md | ✅ |
| 3 | Ego | `~/.janus/EGO.md` | ❌ skipped |
| 4 | Agents | `./AGENTS.md` + per-user override | ❌ skipped |
| 5 | Heartbeat | `./HEARTBEAT.md` + per-user override | ❌ skipped |
| 6 | Project | `./JANUS.md` | ❌ skipped |
| 7 | Skills | SKILL.md files (lazy stubs or full body) | ✅ |
| 8 | Memory | FTS5 + vector hybrid search with scope filtering | ❌ skipped |
| 9 | Learner | Recommendations from similar past executions | ❌ skipped |

Pinned skill files are snapshots for the current model request. After file reads
or potentially mutating tools, a turn with pins rebuilds its context before the
next request, updating both the system message and cached-provider system parts.
This also covers failed tools that wrote before failing and formerly missing files.
Explicit reads always use normal tool gates and path/user validation; they never
redirect the model to a stale snapshot. Rebuilds use the existing symlink guard.

Subagents use **minimal mode**, retaining configured AGENTS.md rules (including user overrides), identity, skills and session context. Trusted request context carries user/scope/agent, owner status and tool filters into a separate UUID session. Child permissions cannot exceed the parent; missing identity is rejected in multi-user delegation. Each child increments depth, registers its parent run ID and combines parent cancellation with its own controller. Execution limits come from the same agent configuration.

### 4. ProviderRegistry (`src/llm/provider-registry.ts`)

Multi-provider LLM with failover:
- Routes by purpose (`chat`, `summarize`, `flush`)
- Priority-based selection (lower = higher priority)
- Automatic failover on provider error
- Streaming support (`chatStream`)

Providers: OpenRouter, Anthropic, OpenAI, DeepSeek, Groq (OpenAI-compatible API), Claude Agent (subscription via SDK), Codex (subscription via SDK).

### 5. Tools (`src/tools/`)

15 built-in tools:

| Tool | Description |
|------|-------------|
| `exec` | Run shell commands (sandboxed, deny patterns) |
| `read_file` | Read file contents |
| `write_file` | Write/create files |
| `edit_file` | Find-and-replace in files |
| `append_file` | Append content to files |
| `list_dir` | List directory contents |
| `message` | Send message to user via bus |
| `spawn_agent` | Spawn child agent for subtasks |
| `cron` | Manage persistent cron jobs |
| `web_fetch` | Fetch URLs (HTML→markdown, JSON, size/redirect guards) |
| `web_search` | Web search (Brave API or DuckDuckGo fallback) |
| `browser` | Headless Chromium via Playwright (optional dep, 3rd tier) |
| `heartbeat` | Manage periodic heartbeat tasks |
| `self_update` | Check/apply updates (git pull, test, restart) |
| `invite` | Generate Telegram invite links for new users |

**Shell authorization:** `exec` is owner-only when `users` is nonempty, enforced by ToolRegistry and ExecTool. Unknown users and identity-free system jobs are denied; delegated turns retain parent restrictions. Single-user mode remains available. `tools.execEnabled: false` disables registration and execution. Cwd validation and regex deny patterns do not isolate the process; a real sandbox is required before granting shell access to non-owners.

**Gates:** Pattern-based confirmation before destructive commands (rm, git push, etc.), applied after owner authorization.

### Cancellation

The session controller, caller signal, lane watchdog and shutdown signal combine into one turn signal. It reaches provider SDK requests/streams, compaction and RequestContext. Registry failover/retries and stream callbacks stop after abort; late responses cannot start tools or publish final output. Tool gates recheck immediately before execution. File writes recheck after preparatory awaits; exec kills its process tree and web tools pass cancellation into fetch. Already-issued side effects are not rolled back. Parallel tools retain session ownership until every started operation settles, including tools that ignore cancellation. The watchdog frees a lane slot once but does not unlock a still-running session.

Agent deadlines use a throwing helper that removes its timer and abort listener on every settlement path. Retry sleeps are abortable and remove their listeners; late rejected work is consumed without resuming a cancelled continuation. Startup retains its separate result-returning timeout helper.

### Context budget configuration

`llm.contextWindows` maps provider names to exact model IDs and their verified context limits (for example, `{"test-provider":{"small-test-model":16000}}` in a synthetic setup). The selected candidate, including an operator pin or fallback, is checked immediately before each chat/stream call. Unknown models use the existing conservative 200,000-token fallback; configure smaller limits explicitly. `agent.contextWindow` is a global cap and cannot enlarge a model limit. Actual `maxTokens` is reserved; a reservation at or above the window leaves zero prompt capacity. A fallback too small for the request is skipped without a network call or circuit-breaker penalty. This is a character-based estimate, not an exact tokenizer.

`agent.context.softTrimChars` and `protectedTailTurns` control trimming; zero protected turns allows all old tool results to be trimmed. `keepRecentTokens` controls the retained transcript. Legacy `reserveTokens`, `toolResultMaxShare`, `toolResultHardMax`, `compactionThresholds` and `emergencyThreshold` remain readable but are deprecated: config loading warns when explicitly supplied. Reservation now follows `maxTokens`; the unified tool-result cap and single router replace the old caps and staged thresholds. The example config omits these obsolete options.

## Memory System (`src/memory/`)

### Session compaction snapshots

Before a summarizer request, SessionManager captures a detached prefix, its previous summary and a single cut boundary under the session lock. Commit reuses that boundary and preserves all messages appended while the model was running. Clear, rotation and force-drop invalidate older snapshots; stale responses and delayed timeout fallbacks cannot replace a newer session generation. A final assistant/tool group stays intact even if it exceeds the tail budget. Existing JSONL sessions remain readable without migration. Rotation first copies the live transcript to an exclusive archive, then atomically replaces the live file and finally publishes the cache. Archive/write/rename failures leave the old live state readable and propagate an error. Timeout fallback uses the same archive-before-replacement order, preserves the last summary and records a separate compactionFailure diagnostic; archives are never automatically deleted. Memory flush uses a persisted absolute message sequence and an epoch changed by clear. Rotation advances only the transcript offset, never the acknowledged cursor. Flush captures a detached input and acknowledges its boundary only after all note writes and the atomic cursor checkpoint succeed; newer messages remain pending across rotation and restart. Legacy positional cursors are not trusted: the retained tail may be replayed once. Note appends and the checkpoint are not one transaction, so a crash between them can duplicate notes. Archived prefixes are retained for recovery, not automatically replayed by flush.

Summary output is accepted only after a normal stop with every required template section populated. Empty, prefill-only, length-limited and structurally incomplete responses are rejected. At most two attempts use the same captured prefix; after both fail, identical input is suppressed for the lifetime of the loop instance. The previous summary and transcript remain intact. Short previous summaries are preserved in the update prompt. Structural validation cannot prove semantic completeness or recover facts already lost by older versions.

### Storage
- `MEMORY.md` — persistent knowledge (agent-editable via `write_file`)
- `memory/YYYY-MM-DD.md` — daily notes (auto-populated by memory flush)

### Search (MemoryIndex)
- **FTS5** — keyword search with BM25 ranking
- **Temporal decay** — 30-day half-life; MEMORY.md chunks are evergreen
- **Vector search** (opt-in) — local embeddings via `@xenova/transformers` (all-MiniLM-L6-v2, 384-dim)
- **Hybrid search** — Reciprocal Rank Fusion (RRF) combining FTS5 + vector results
- **Index freshness** — MemoryStore writes and validated write/edit/append tools update FTS in their own user/chat/isolated-agent/global scope. Before searching, stat versions in that scope detect external changes; unchanged files are not reread or reindexed. Empty and deleted files remove prior chunks, including after restart. Symlinked memory directories/files are excluded.
- **Background vectors** — changed files queue embeddings without delaying writes; row/content/scope checks prevent stale inference from attaching to replacement rows. Startup discovers isolated-agent memory too. HISTORY.md and MEMORY backups are excluded from current search to avoid importing mixed-scope logs or superseded facts.

### Memory Flush
Before summarization discards old messages, LLM extracts key facts → `appendDaily()`.

## Database (`src/db/`)

SQLite (better-sqlite3, WAL mode). 5 migrations:
1. `memory_chunks` + FTS5 virtual table + triggers
2. `learner_records`
3. `cron_jobs` + `cron_runs`
4. `embedding` column on `memory_chunks`
5. Multi-user columns (`owner`, `scope`, `scope_id`) on `memory_chunks`

Falls back to file-based storage when disabled.

## Services

### CronService (`src/services/cron-service.ts`)
Persistent cron scheduler. 3 schedule kinds: `at` (one-shot), `every` (interval), `cron` (expression). SQLite-backed, run history, exponential backoff on errors.

### HeartbeatService (`src/services/heartbeat-service.ts`)
Parses `HEARTBEAT.md` for periodic tasks. Supports per-user `HEARTBEAT.md` in `.janus/users/{userId}/` — per-user tasks are tagged with `userId` and routed to the correct Telegram chat. Syncs to CronService when available. See [PER-USER.md](PER-USER.md).

## MCP Server (`src/mcp/`)

Exposes Janus tools via Model Context Protocol (JSON-RPC 2.0 over stdio):
- `src/mcp/server.ts` — request handling, tool/prompt registration
- `src/mcp/tool-bridge.ts` — maps ToolRegistry → MCP tools
- `src/mcp/stdio-transport.ts` — JSONL over stdin/stdout

Usage: `npm start -- mcp-server`

Configure in editor (e.g. Claude Code):
```json
{ "janus": { "command": "npm", "args": ["start", "--", "mcp-server"], "cwd": "/path/to/workspace" } }
```

## Config (`src/config/schema.ts`)

`janus.json` (all config including API keys and tokens). Env vars supported as overrides. Zod-validated.

Key sections: `llm`, `agent`, `workspace`, `tools`, `database`, `heartbeat`, `telegram`, `streaming`, `gates`, `memory`, `voice`, `users`, `family`, `mcp`, `autoUpdate`.

## Testing

352 tests across 38 files. Vitest. Mock LLM provider for integration tests. In-memory SQLite for DB tests.

```bash
npm test           # Run all tests
npm run typecheck  # TypeScript type checking
```
