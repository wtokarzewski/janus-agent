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

**Status (Phase 7):** ~6,000 LOC, 176 tests across 21 files, CI pipeline. See [FEATURES.md](../FEATURES.md) for full feature list.

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

### 3. ContextBuilder (`src/context/context-builder.ts`)

Assembles system prompt from multiple sources:

| # | Section | Source | Minimal mode |
|---|---------|--------|-------------|
| 1 | Identity | Built-in (time, workspace, tools) | ✅ |
| 2 | Ego | `~/.janus/EGO.md` | ❌ skipped |
| 3 | Agents | `./AGENTS.md` | ❌ skipped |
| 4 | Heartbeat | `./HEARTBEAT.md` | ❌ skipped |
| 5 | Project | `./JANUS.md` | ❌ skipped |
| 6 | Skills | SKILL.md files (lazy stubs) | ✅ |
| 7 | Memory | FTS5 + vector hybrid search | ❌ skipped |
| 8 | Session | Channel + chat ID | ✅ |
| 9 | Summary | Previous session summary | ✅ |

Subagents use **minimal mode** (identity + skills + session only) to save tokens.

### 4. ProviderRegistry (`src/llm/provider-registry.ts`)

Multi-provider LLM with failover:
- Routes by purpose (`chat`, `summarize`, `flush`)
- Priority-based selection (lower = higher priority)
- Automatic failover on provider error
- Streaming support (`chatStream`)

Providers: OpenRouter, Anthropic, OpenAI, DeepSeek, Groq (OpenAI-compatible API), Claude Agent (subscription via SDK), Codex (subscription via SDK).

### 5. Tools (`src/tools/`)

8 built-in tools:

| Tool | Description |
|------|-------------|
| `exec` | Run shell commands (sandboxed, deny patterns) |
| `read_file` | Read file contents |
| `write_file` | Write/create files |
| `edit_file` | Find-and-replace in files |
| `list_dir` | List directory contents |
| `message` | Send message to user via bus |
| `spawn_agent` | Spawn child agent for subtasks |
| `cron` | Manage persistent cron jobs |

**Gates:** Pattern-based confirmation before destructive commands (rm, git push, etc.).

## Memory System (`src/memory/`)

### Storage
- `MEMORY.md` — persistent knowledge (agent-editable via `write_file`)
- `memory/YYYY-MM-DD.md` — daily notes (auto-populated by memory flush)

### Search (MemoryIndex)
- **FTS5** — keyword search with BM25 ranking
- **Temporal decay** — 30-day half-life; MEMORY.md chunks are evergreen
- **Vector search** (opt-in) — local embeddings via `@xenova/transformers` (all-MiniLM-L6-v2, 384-dim)
- **Hybrid search** — Reciprocal Rank Fusion (RRF) combining FTS5 + vector results

### Memory Flush
Before summarization discards old messages, LLM extracts key facts → `appendDaily()`.

## Database (`src/db/`)

SQLite (better-sqlite3, WAL mode). 4 migrations:
1. `memory_chunks` + FTS5 virtual table + triggers
2. `learner_records`
3. `cron_jobs` + `cron_runs`
4. `embedding` column on `memory_chunks`

Falls back to file-based storage when disabled.

## Services

### CronService (`src/services/cron-service.ts`)
Persistent cron scheduler. 3 schedule kinds: `at` (one-shot), `every` (interval), `cron` (expression). SQLite-backed, run history, exponential backoff on errors.

### HeartbeatService (`src/services/heartbeat-service.ts`)
Parses `HEARTBEAT.md` for periodic tasks. Syncs to CronService when available.

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

`janus.json` + env vars. Zod-validated.

Key sections: `llm`, `agent`, `workspace`, `tools`, `database`, `heartbeat`, `telegram`, `streaming`, `gates`, `memory`.

## Testing

176 tests across 21 files. Vitest. Mock LLM provider for integration tests. In-memory SQLite for DB tests.

```bash
npm test           # Run all tests
npm run typecheck  # TypeScript type checking
```
