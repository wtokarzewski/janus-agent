# Roadmap

## Current State (Phase 8 complete)

- **Codebase:** ~10,800 LOC TypeScript (82 src files), 347 tests across 37 files, CI
- **Runtime deps:** 12 + 1 optional (@anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk, @openai/codex-sdk, @xenova/transformers, better-sqlite3, chalk, commander, croner, grammy, openai, yaml, zod; optional: playwright)
- **Providers:** 8 (openrouter, anthropic, openai, deepseek, groq, claude-agent, codex, codex-oauth)
- **Tools:** 15 (exec, read/write/edit/append-file, list-dir, message, spawn_agent, cron, web_fetch, web_search, browser, heartbeat, self_update, invite)
- **Skills:** 6 (programmer, meal-planner, home-assistant, personal-travel, stock-watcher, google-workspace)
- **Channels:** 2 (CLI, Telegram) + MCP server + MCP client
- **DB:** SQLite (WAL, 5 migrations: memory_chunks+FTS5, learner_records, cron_jobs+cron_runs, embedding, multi-user)

See [FEATURES.md](../FEATURES.md) for the full verified feature list.

## Completed Phases

### Phase 1: Foundation
- CLI + Telegram channels, MessageBus, AgentLoop, ToolRegistry
- 7 built-in tools, SKILL.md loader, ContextBuilder
- Session persistence (JSONL), config (Zod schema)

### Phase 2: Intelligence
- HeartbeatService, error recovery, multi-provider failover
- Subagent spawning, Learner (execution metrics)
- Bootstrap files: EGO.md, JANUS.md, AGENTS.md, HEARTBEAT.md

### Phase 3: Memory & Storage
- SQLite database (better-sqlite3, WAL mode, numbered migrations)
- FTS5 hybrid memory search (BM25 ranking, heading chunks)
- SQLite learner storage (primary) + JSONL fallback
- 69 tests, CI pipeline (GitHub Actions)

### Phase 4: Streaming & Gates
- LLM streaming (both providers), real-time bus delivery
- CLI inline output, Telegram edit-in-place (throttled)
- PatternGate (regex), CLIGate (readline), TelegramGate (inline keyboard)

### Phase 5: Scaling
- Bootstrap dedup: shared createApp() in bootstrap.ts
- Lazy skill loading: XML stubs with location, agent reads on demand
- Token management: tokenBudget from config, estimateTokens (÷2.5), emergency compression, token-based summarization
- CronService: persistent SQLite scheduler (at/every/cron), croner lib, run history, backoff, cron tool
- 95 tests

### Phase 6: Vector Search + MCP + Memory + Subagent Optimization
- Heartbeat/cron no-op response suppression
- Minimal prompt mode for subagents (identity + skills + session only)
- Memory flush before compaction (LLM extracts key facts → daily notes)
- Temporal decay in FTS5 search (30-day half-life, MEMORY.md evergreen)
- Vector search with local embeddings (@xenova/transformers, all-MiniLM-L6-v2, RRF fusion)
- MCP server (JSON-RPC over stdio, tool bridge, `npm start -- mcp-server`)
- 122 tests

### Phase 7: Multi-User + Subscription Providers
- Subscription providers: claude-agent (Claude Code Max via @anthropic-ai/claude-agent-sdk), codex (ChatGPT Plus/Pro via @openai/codex-sdk)
- Structured output: JSON schema enforcement on subscription providers via sdk-utils.ts
- Setup wizard: interactive first-run config, API key or subscription path
- `/config` command: CLI reconfiguration during session
- Config persistence: saveConfig() (workspace or user scope)
- Multi-user: UserResolver, per-user PROFILE.md, tool/skill allow/deny per user
- Per-user memory: scoped memory chunks (owner + scope filtering in MemoryIndex)
- Family groups: shared memory scope via groupChatIds
- 176 tests

### Phase 8: Reliability + Security + Tools + Skills
- Native OAuth (PKCE S256) for Anthropic + Codex, token storage with auto-refresh
- `/stop` command: cancel mid-task (AgentLoop.stop(), SubagentRegistry.cancelAll())
- 6 new tools: web_fetch, web_search, append_file, heartbeat, self_update, invite
- MCP client: connect to external MCP servers, auto-discover tools
- Steering messages: mid-run user input injection via MessageBus
- Extended thinking/reasoning support (Anthropic), prompt caching (cache_control: ephemeral)
- 5xx failover, cross-provider tool ID normalization, duplicate tool call prevention
- Orphan tool_use repair (repairToolMessages), history token budget trimming
- PROFILE.md auto-update: agent learns preferences → writes to .janus/users/{userId}/PROFILE.md
- Invite system: Telegram deep-link onboarding, InviteStore (24h TTL), runtime + persistent allowlist
- Telegram hardening: drop pending updates on startup, markdown URL cleanup
- Self-update: git pull + npm install + test + self-respawn, Docker detection, auto-revert
- 5 new skills: meal-planner, home-assistant, stock-watcher, google-workspace, personal-travel
- Per-user overrides: AGENTS.md + HEARTBEAT.md per user, heartbeat routing to user's Telegram chat
- `npm start -- update` CLI command: one-step project update (pull + install + test + user dirs), auto-revert on failure
- Auto user dir setup: `ensureUserDir()` in user-resolver creates `.janus/users/{id}/` on first resolution (channel-agnostic)
- Multi-lane concurrent message queue (semaphore, user:3/cron:1/heartbeat:1, AbortSignal)
- Skill-creator meta-skill, mtime-based cache invalidation
- LLM overload resilience (5-retry exponential backoff, user notification, abort-aware sleep)
- SDK timeout hardening (2 min per request, 90s background call hard cap)
- Multi-provider OAuth (shared FileTokenStore, `providers[]` with auth/priority/purpose)
- Dynamic model listing from APIs (Anthropic + OpenAI) in setup wizard
- Setup wizard with fallback provider selection
- Windows compatibility (path separator, conditional test skipping)
- Diagnostic timing logs throughout message processing pipeline
- Leaked control token stripping (sanitize LLM artifacts from user-facing output)
- Telegram forum/topic session isolation (per-topic sessions in forum supergroups)
- Group mention policy (`telegram.groupPolicy: all|mention`)
- Cron missed job staggering (spread missed jobs 30s apart on restart)
- Browser tool (Playwright headless Chromium, optional dep, 3rd escalation: search→fetch→browser)
- 347 tests across 37 files

**Remaining:**
- Tool policy enforcement (domain filters, content rating) — schema exists, enforcement stubbed
- Voice transcription (Groq Whisper, TG voice → text)
- Q&A Loop (iterative requirements gathering)

---

## Dropped Features (and why)

| Feature | Why |
|---------|-----|
| Complexity classifier | Wrong to classify before execution. Flat loops work better. |
| 7-phase orchestrator | Rigid pipeline. LLM decides order. Replaced by AgentLoop. |
| Task runner + dep graph | Overengineering. Free-form loop suffices. |
| Context minimizer | Premature. Not MVP. |
| 14-phase programmer workflow | Too rigid. Simplified to SKILL.md. |
| Hook system (16 events) | Not needed at current scale. |

---

## Differentiators

Features that set Janus apart from other AI agents:

- **Local embeddings** — all-MiniLM-L6-v2 via ONNX. Zero API cost, zero latency.
- **Hybrid search (FTS5 + vector + RRF)** — keyword AND semantic search combined with temporal decay.
- **Learner** — Records execution metrics and provides keyword-based recommendations.
- **Memory flush before compaction** — Preserves knowledge during session summarization.
- **Minimal subagent prompts** — Child agents get stripped context, saving tokens.
- **Persistent cron scheduler** — SQLite-backed, survives restarts, exponential backoff.
- **MCP server** — Editors can use Janus tools directly via reverse provider.
- **Simplicity** — ~10.4K LOC. Minimal codebase, full capabilities.
- **Native OAuth** — PKCE flows for Anthropic + Codex. No CLI SDK dependency required.
- **Steering messages** — Mid-run user injection. User can redirect agent during tool execution.
- **Family skills** — Meal planner, Home Assistant, stock watcher, travel planner, Google Workspace.
