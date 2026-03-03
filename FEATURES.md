# Features

Canonical list of implemented, working features. Verified against source code and 176 passing tests.

**Last updated:** 2026-02-24

---

## Agent Core

- **Flat agent loop** — LLM decides what to do, tools execute, loop repeats until done. No rigid pipeline or pre-classification.
- **Subagent spawning** — `spawn_agent` tool creates child AgentLoop with isolated session. Minimal prompt mode (identity + skills + session only) saves tokens.
- **Emergency compression** — On context overflow, drops oldest 50% of messages and retries (up to 2x).
- **Token-based summarization** — When session tokens exceed 75% of budget, triggers async summarization.
- **Memory flush before compaction** — Before summarization discards old messages, LLM extracts key facts into daily notes. Preserves knowledge across compaction.
- **No-op suppression** — Heartbeat/cron responses like "HEARTBEAT_OK" are not routed to the user.

## LLM Providers (7)

Two auth modes (mutually exclusive):

| Provider | Type | Protocol |
|----------|------|----------|
| `openrouter` | API key | OpenAI-compatible |
| `anthropic` | API key | Anthropic native |
| `openai` | API key | OpenAI-compatible |
| `deepseek` | API key | OpenAI-compatible |
| `groq` | API key | OpenAI-compatible |
| `claude-agent` | Subscription (Claude Code Max) | @anthropic-ai/claude-agent-sdk |
| `codex` | Subscription (ChatGPT Plus/Pro) | @openai/codex-sdk |

- **Multi-provider failover** — Priority-ordered list, automatic failover on error. Purpose-based routing (chat, summarize, flush).
- **Streaming** — `chatStream()` on Anthropic + OpenAI-compatible providers. Real-time chunk delivery via MessageBus to CLI and Telegram.
- **Structured output** — Subscription providers use JSON schema enforcement via `sdk-utils.ts` (~99% reliability + fallback parsing).
- **Setup wizard** — Interactive first-run config. Detects API key vs subscription. `/config` command for reconfiguration.

## Tools (8)

| Tool | Description |
|------|-------------|
| `exec` | Shell commands. Deny patterns (rm -rf, mkfs, fork bomb, etc.). Configurable timeout. |
| `read_file` | Read file contents with size limit. |
| `write_file` | Create/overwrite files with atomic writes. |
| `edit_file` | Find-and-replace in files. |
| `list_dir` | List directory contents with sizes. |
| `message` | Send message to user via bus. |
| `spawn_agent` | Spawn child agent for subtasks (minimal prompt, isolated session). |
| `cron` | Create, list, update, delete persistent cron jobs. |

### Tool Infrastructure

- **Tool registry** — Centralized tool registration with per-user allow/deny lists.
- **Gate integration** — Pattern-based confirmation before destructive commands.
- **Context injection** — Tools receive workspace dir, chatId, userId.
- **Result truncation** — Tool output capped at 4000 chars.
- **Retry** — Automatic retry on tool failure (configurable, default 2x).

## Memory System

- **MEMORY.md** — Persistent knowledge file. Agent reads/writes via tools. Evergreen in search ranking.
- **Daily notes** — `memory/YYYY-MM-DD.md`. Auto-populated by memory flush before compaction.
- **FTS5 search** — SQLite full-text search with BM25 ranking.
- **Vector search** — Local embeddings via `@xenova/transformers` (all-MiniLM-L6-v2, 384-dim, ONNX). Zero API cost. Opt-in via `memory.vectorSearch` config.
- **Hybrid search (RRF)** — Reciprocal Rank Fusion combining FTS5 + vector results.
- **Temporal decay** — 30-day half-life. Recent content ranks higher. MEMORY.md chunks exempt (evergreen).
- **Scope filtering** — Memory chunks tagged with owner/scope for multi-user isolation.
- **Markdown chunking** — Split by `##` headings. Further split at paragraph boundaries when chunk exceeds 2000 chars.
- **Async reindex** — Embedding computation is non-blocking.

## Channels (2 + MCP)

| Channel | Features |
|---------|----------|
| **CLI** | Interactive REPL, single-message mode (`-m`), persistent history (~/.janus/history), `/help` and `/config` commands, inline streaming output, gate confirmation via readline. |
| **Telegram** | Grammy bot, user allowlist, streaming via edit-in-place (500ms throttle), gate confirmation via inline keyboard, message splitting (4096 char limit), `/whoami` diagnostic. |
| **MCP Server** | JSON-RPC 2.0 over stdio. Exposes tools and prompts to editors (VS Code, Cursor, Claude Code). Tool bridge maps ToolRegistry to MCP protocol. |

## Gates (Safety)

- **PatternGate** — Regex-based confirmation before destructive `exec` commands.
- **Default patterns:** `rm`, `git push`, `git reset`, `npm publish`, `docker rm`.
- **CLIGate** — Readline yes/no confirmation. 30s timeout (auto-deny).
- **TelegramGate** — Inline keyboard (Approve / Deny) confirmation. 60s timeout (auto-deny).
- **Wired into ToolRegistry** — Gate check runs before every tool execution.

## Scheduling

- **CronService** — SQLite-backed persistent scheduler. Survives restarts.
  - 3 schedule kinds: `at` (one-shot), `every` (interval), `cron` (expression via croner).
  - Timezone support for cron expressions.
  - Run history tracking, exponential backoff on consecutive errors (30s → 60s → 5m → 15m → 1h).
  - CRUD: addJob, updateJob, removeJob, listJobs, getRuns.
- **HeartbeatService** — Parses `HEARTBEAT.md` for periodic tasks.
  - Supports `every Xm/h/d` and cron expressions.
  - Syncs to CronService when available, falls back to in-memory timers.

## Multi-User

- **UserResolver** — Resolves inbound message sender to user profile by channel + ID (stable) or username (fallback).
- **Per-user profiles** — `~/.janus/users/{userId}/PROFILE.md` with name, identities, tool/skill allow/deny lists.
- **Per-user memory** — Scoped memory chunks (owner + scope filtering in MemoryIndex).
- **Family groups** — Shared memory scope via `family.groupChatIds` config.
- **Wired into AgentLoop** — User profile passed to context builder, tool context, learner.

## Learner

- **Execution metrics** — Records task, duration, iterations, tool calls, token usage, outcome per agent run.
- **SQLite storage** (primary) with JSONL fallback.
- **Keyword similarity** — Finds similar past tasks by keyword overlap.
- **Recommendations** — Returns avgDuration, avgIterations, avgToolCalls, successRate from similar executions. Wired into system prompt via context builder.

## Skills

- **SKILL.md format** — YAML frontmatter (name, description, version, always, requires) + markdown body.
- **3-source loading** — workspace/skills → ~/.janus/skills → builtin/skills.
- **Lazy loading** — Skills emit XML stubs with `location` attribute. Agent reads full content on demand via `read_file`. `always: true` skills inlined in system prompt.
- **Per-user filtering** — Skills filtered by user allow/deny lists.
- **Config limits** — `maxSkillsInPrompt`, `maxSkillsPromptChars`.

## Sessions

- **JSONL persistence** — One message per line, atomic writes (write-then-rename). First line = metadata.
- **Memory cache** — In-memory + file for performance.
- **Summarization** — Async, non-blocking. Split-half strategy: keep last 4 messages, summarize the rest.
- **Crash recovery** — Orphan tool messages stripped on load.

## Context Builder

Assembles system prompt from multiple sources:

| # | Section | Source | In minimal mode |
|---|---------|--------|-----------------|
| 1 | Identity | Built-in (timestamp, workspace, available tools) | Yes |
| 2 | User profile | Per-user PROFILE.md | Yes |
| 3 | Ego | `~/.janus/EGO.md` | No |
| 4 | Agents | `./AGENTS.md` | No |
| 5 | Heartbeat | `./HEARTBEAT.md` | No |
| 6 | Project | `./JANUS.md` | No |
| 7 | Skills | SKILL.md files (lazy stubs or full body) | Yes |
| 8 | Memory | FTS5 + vector hybrid search with scope filtering | No |
| 9 | Learner | Recommendations from similar past executions | No |

Subagents use minimal mode (identity + user + skills only) to save tokens.

## Bootstrap Files

| File | Scope | Purpose |
|------|-------|---------|
| `~/.janus/EGO.md` | Global | Agent character and personality |
| `./JANUS.md` | Per-repo | Project-specific instructions (like CLAUDE.md) |
| `./AGENTS.md` | Per-workspace | Agent behavior rules |
| `./HEARTBEAT.md` | Per-workspace | Autonomous periodic tasks |
| `~/.janus/users/{id}/PROFILE.md` | Per-user | User preferences and identity |

## Database

- **SQLite** (better-sqlite3), WAL mode, numbered migrations.
- **4 migrations:** memory_chunks + FTS5, learner_records, cron_jobs + cron_runs, embedding column.
- **Graceful fallback** — File-based storage when database disabled.

## Configuration

`janus.json` (workspace) + `~/.janus/config.json` (user) + env vars. Zod-validated.

| Section | Key settings |
|---------|-------------|
| `llm` | provider, model, apiKey, apiBase, maxTokens, temperature, providers[] |
| `agent` | maxIterations, tokenBudget, contextWindow, toolRetries, maxSubagentIterations, maxSkillsInPrompt |
| `workspace` | dir, memoryDir, sessionsDir, skillsDir |
| `tools` | execTimeout, execDenyPatterns[], maxFileSize |
| `database` | enabled, path |
| `heartbeat` | enabled, checkIntervalMs |
| `telegram` | enabled, token, allowlist[] |
| `streaming` | enabled, telegramThrottleMs |
| `gates` | enabled, execPatterns[] |
| `memory` | vectorSearch |
| `users[]` | id, name, identities[], tools{allow,deny}, skills{allow,deny} |
| `family` | id, name, groupChatIds[] |

Load priority: defaults < user config < workspace config < env vars.

## Infrastructure

- **MessageBus** — AsyncQueue with bounded capacity (100) and backpressure.
- **Shared bootstrap** — `createApp()` in `bootstrap.ts` eliminates duplication between CLI and gateway.
- **Docker** — Multi-stage Dockerfile (node:20-bookworm), docker-compose.yml.
- **CI** — GitHub Actions (typecheck + vitest on push/PR).
- **Tests** — 176 tests across 21 files (vitest, mock LLM, in-memory SQLite).

## Commands

```bash
npm start                    # Interactive CLI
npm start -- -m "message"   # Single message mode
npm start -- gateway        # Headless mode (Telegram + services)
npm start -- onboard        # Initialize workspace
npm start -- mcp-server     # MCP server (stdin/stdout JSON-RPC)
npm start -- setup          # Configure LLM provider
```
