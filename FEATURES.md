# Features

Canonical list of implemented, working features. Verified against source code and 325 passing tests.

**Last updated:** 2026-03-08

---

## Agent Core

- **Flat agent loop** — LLM decides what to do, tools execute, loop repeats until done. No rigid pipeline or pre-classification.
- **Subagent spawning** — `spawn_agent` tool creates child AgentLoop with isolated session. Minimal prompt mode (identity + skills + session only) saves tokens.
- **Emergency compression** — On context overflow, drops oldest 50% of messages and retries (up to 2x).
- **Token-based summarization** — When session tokens exceed 75% of budget, triggers async summarization.
- **Memory flush before compaction** — Before summarization discards old messages, LLM extracts key facts into daily notes. Preserves knowledge across compaction.
- **No-op suppression** — Heartbeat/cron responses like "HEARTBEAT_OK" are not routed to the user.

## LLM Providers (8)

Three auth modes (mutually exclusive):

| Provider | Type | Protocol |
|----------|------|----------|
| `openrouter` | API key | OpenAI-compatible |
| `anthropic` | API key | Anthropic native |
| `openai` | API key | OpenAI-compatible |
| `deepseek` | API key | OpenAI-compatible |
| `groq` | API key | OpenAI-compatible |
| `claude-agent` | Subscription (Claude Code Max) | @anthropic-ai/claude-agent-sdk |
| `codex` | Subscription (ChatGPT Plus/Pro) | @openai/codex-sdk |
| `codex` (OAuth) | Subscription, native OAuth | Responses API (PKCE) |

- **Native OAuth (PKCE)** — Browser-based login for Anthropic + Codex with auto-refresh. File-based token storage (`~/.janus/auth.json`, 0o600).
- **Extended thinking** — `llm.thinking.enabled` + `budgetTokens`. Thinking levels: off/minimal/low/medium/high.
- **Prompt caching** — `cache_control: ephemeral` on system prompt + last tool def. Timestamp in dynamic session tail for cache stability.
- **Multi-provider failover** — Priority-ordered list, automatic failover on error. Purpose-based routing (chat, summarize, flush).
- **Streaming** — `chatStream()` on Anthropic + OpenAI-compatible providers. Real-time chunk delivery via MessageBus to CLI and Telegram.
- **Structured output** — Subscription providers use JSON schema enforcement via `sdk-utils.ts` (~99% reliability + fallback parsing).
- **Setup wizard** — Interactive first-run config. Detects API key vs subscription. `/config` command for reconfiguration.

## Tools (14)

| Tool | Description |
|------|-------------|
| `exec` | Shell commands. Deny patterns (rm -rf, mkfs, fork bomb, etc.). Configurable timeout. |
| `read_file` | Read file contents with size limit. |
| `write_file` | Create/overwrite files with atomic writes. |
| `edit_file` | Find-and-replace in files. |
| `append_file` | Append content to files. |
| `list_dir` | List directory contents with sizes. |
| `message` | Send message to user via bus. |
| `spawn_agent` | Spawn child agent for subtasks (minimal prompt, isolated session). |
| `cron` | Create, list, update, delete persistent cron jobs. |
| `web_fetch` | Fetch URLs (HTML→markdown, JSON, size/redirect guards, browser User-Agent). |
| `web_search` | Web search (Brave API or DuckDuckGo fallback, in-memory cache 15min TTL). |
| `heartbeat` | Manage periodic heartbeat tasks. |
| `self_update` | Check/apply updates (git pull, npm install, test, self-respawn, auto-revert). |
| `invite` | Generate Telegram invite links for new user onboarding. |

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
| **Telegram** | Grammy bot, user allowlist, streaming via edit-in-place (500ms throttle), gate confirmation via inline keyboard, message splitting (4096 char limit), `/whoami` diagnostic, `/stop` command, invite deep-link onboarding, drop pending updates on startup, markdown URL cleanup. |
| **MCP Server** | JSON-RPC 2.0 over stdio. Exposes tools and prompts to editors (VS Code, Cursor, Claude Code). Tool bridge maps ToolRegistry to MCP protocol. |
| **MCP Client** | Connect to external MCP servers. Config-driven `mcp.servers[]`. Auto-discover tools, register as `mcp_{server}_{tool}`. |

## Gates (Safety)

- **PatternGate** — Regex-based confirmation before destructive `exec` commands.
- **Default patterns:** `rm`, `git push`, `git reset`, `npm publish`, `docker rm`.
- **CLIGate** — Readline yes/no confirmation. 30s timeout (auto-deny).
- **TelegramGate** — Inline keyboard (Approve / Deny) confirmation. 60s timeout (auto-deny).
- **Wired into ToolRegistry** — Gate check runs before every tool execution.
- **Path validation** — `realpathSync()` + workspace prefix check on all file tools. Symlink safety.
- **Obfuscation detection** — 8 patterns (base64 pipe, xxd, eval, etc.) + whitelist in PatternGate.
- **Gate on file writes** — 11 sensitive path patterns (/etc, .ssh, .env, .git/config, etc.).
- **Gate on spawn_agent** — Always gated with task preview.
- **Process group kill** — `spawn({detached:true})` + `kill(-pid)` on exec timeout.

## Scheduling

- **CronService** — SQLite-backed persistent scheduler. Survives restarts.
  - 3 schedule kinds: `at` (one-shot), `every` (interval), `cron` (expression via croner).
  - Timezone support for cron expressions.
  - Run history tracking, exponential backoff on consecutive errors (30s → 60s → 5m → 15m → 1h).
  - CRUD: addJob, updateJob, removeJob, listJobs, getRuns.
- **HeartbeatService** — Parses `HEARTBEAT.md` for periodic tasks.
  - Supports `every Xm/h/d` and cron expressions.
  - Per-user `HEARTBEAT.md` in `.janus/users/{userId}/` — tasks tagged with userId, routed to user's Telegram chat.
  - Auto-starts when any HEARTBEAT.md exists (global or per-user).
  - Syncs to CronService when available, falls back to in-memory timers.

## Multi-User

- **UserResolver** — Resolves inbound message sender to user profile by channel + ID (stable) or username (fallback).
- **Per-user profiles** — `.janus/users/{userId}/PROFILE.md` (workspace). Auto-updated by agent when learning user preferences.
- **Per-user AGENTS.md** — `.janus/users/{userId}/AGENTS.md` overrides global agent behavior. Appended to global AGENTS.md in system prompt.
- **Per-user HEARTBEAT.md** — `.janus/users/{userId}/HEARTBEAT.md` for personal scheduled tasks. Routed to user's Telegram chat.
- **Per-user memory** — Scoped memory chunks (owner + scope filtering in MemoryIndex).
- **Family groups** — Shared memory scope via `family.groupChatIds` config.
- **Wired into AgentLoop** — User profile passed to context builder, tool context, learner.

## Invite Links

- **InviteStore** — In-memory token store with 24h TTL. Tokens are base64url (16 chars).
- **Deep links** — `https://t.me/BOT?start=invite_TOKEN`. New user clicks → `/start invite_TOKEN` → auto-added to allowlist + config.users.
- **Persistence** — Invited users saved to `janus.json` (both `config.users` and `telegram.allowlist`).
- **Non-blocking** — Fire-and-forget `ctx.reply()` prevents invite handler from blocking grammY pipeline.
- **Markdown cleanup** — `cleanMarkdownUrls()` strips `**`/`*`/`__`/`_` from URLs before sending to Telegram.

## Learner

- **Execution metrics** — Records task, duration, iterations, tool calls, token usage, outcome per agent run.
- **SQLite storage** (primary) with JSONL fallback.
- **Keyword similarity** — Finds similar past tasks by keyword overlap.
- **Recommendations** — Returns avgDuration, avgIterations, avgToolCalls, successRate from similar executions. Wired into system prompt via context builder.

## Skills (6)

- **SKILL.md format** — YAML frontmatter (name, description, version, always, requires) + markdown body.
- **3-source loading** — workspace/skills → ~/.janus/skills → builtin/skills.
- **Lazy loading** — Skills emit XML stubs with `location` attribute. Agent reads full content on demand via `read_file`. `always: true` skills inlined in system prompt.
- **Per-user filtering** — Skills filtered by user allow/deny lists.
- **Config limits** — `maxSkillsInPrompt`, `maxSkillsPromptChars`.
- **Skill self-creation** — System prompt instructs agent to create SKILL.md for repeated patterns.

| Skill | Description |
|-------|-------------|
| `programmer` | Software development, debugging, code review. Always loaded. |
| `meal-planner` | Weekly meal planning, dietary restrictions, shopping lists. |
| `home-assistant` | Home Assistant REST API control (lights, climate, scenes, scripts). |
| `stock-watcher` | Google Finance watchlist, Python scripts, multi-exchange. |
| `google-workspace` | Gmail, Calendar, Drive, Contacts, Sheets, Docs via `gog` CLI. |
| `personal-travel` | Travel planning, documents, wishlists, budgets. |

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
| 4 | Agents | `./AGENTS.md` + per-user override | No |
| 5 | Heartbeat | `./HEARTBEAT.md` + per-user override | No |
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
| `.janus/users/{id}/PROFILE.md` | Per-user | User preferences and identity |
| `.janus/users/{id}/AGENTS.md` | Per-user | Agent behavior override (appended to global) |
| `.janus/users/{id}/HEARTBEAT.md` | Per-user | Personal scheduled tasks (routed to user's chat) |

## Database

- **SQLite** (better-sqlite3), WAL mode, numbered migrations.
- **5 migrations:** memory_chunks + FTS5, learner_records, cron_jobs + cron_runs, embedding column, multi-user columns (owner, scope, scope_id).
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
- **Tests** — 325 tests across 34 files (vitest, mock LLM, in-memory SQLite).

## Commands

```bash
npm start                    # Interactive CLI
npm start -- -m "message"   # Single message mode
npm start -- gateway        # Headless mode (Telegram + services)
npm start -- onboard        # Initialize workspace
npm start -- mcp-server     # MCP server (stdin/stdout JSON-RPC)
npm start -- setup          # Configure LLM provider
```
