# Roadmap

## Current State (Phase 15 complete + reliability hardening)

- **Version:** 0.14.1
- **Codebase:** ~17,500 LOC TypeScript, 819 tests across 77 files, CI
- **Runtime deps:** 12 + 1 optional (@anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk, @openai/codex-sdk, @xenova/transformers, better-sqlite3, chalk, commander, croner, grammy, openai, yaml, zod; optional: playwright)
- **Providers:** 8 (openrouter, anthropic, openai, deepseek, groq, claude-agent, codex, codex-oauth)
- **Tools:** 16 (exec, read/write/edit/append-file, list-dir, message, send-file, spawn_agent, cron, web_fetch, web_search, browser, heartbeat, self_update, invite)
- **Skills:** 10 (programmer, meal-planner, home-assistant, personal-travel, stock-watcher, google-workspace, github, skill-creator, browser-operator, diet-tracker)
- **Channels:** 2 (CLI, Telegram) + MCP server + MCP client
- **DB:** SQLite (WAL, 13 migrations: memory_chunks+FTS5, learner_records, cron_jobs+cron_runs, embedding, multi-user, per-user cron, cron session IDs, cron chat_id, cron_runs finished_at, cron agent_id, gate_audit_log, not_before, cron targets)

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
- Graceful shutdown flush (flush sessions before SIGTERM/SIGINT abort, memoryFlushInterval 10→5)
- Memory flush v2: pointer-based tracking (lastFlushed), context-aware extraction (session summary + MEMORY.md), triple output (HISTORY.md + daily notes + MEMORY.md holistic update), 5 triggers (count/token/pre-summarization/idle/shutdown)
- Voice transcription: Groq Whisper auto-transcribe for Telegram voice/audio messages, configurable language/duration limit
- GitHub skill: `gh` CLI wrapper — repos, issues, PRs, CI, releases, gists, search
- 352 tests across 38 files

### Phase 9: Multi-User Privacy
- Per-user cron jobs: userId column (migration 6), ownership enforcement in CronService + cron tool
- File access control: validatePath enforces user-scoped access in family chats (users can only access their own `.janus/users/{id}/` directory)
- Chat directories: `ensureChatDir()` creates per-chat dirs (`.janus/chats/{chatId}/`)
- DB hardening: exec deny patterns block direct `sqlite3` access
- Context isolation: system prompt scoped per-user in family chats
- Browser lifecycle fix: setContext preserves runtime across messages, EADDRINUSE recovery with retry
- Silent summarization: ⏳ indicator instead of verbose notifications that confused users mid-task
- 374 tests across 38 files

### Phase 10: Browser Operator + Config Architecture
- Browser Operator: Playwright migration (replaced Chrome Extension + WS server with Playwright persistent context, ~200 lines replaces ~2000 lines)
- Config architecture: providers+slots (providers object + slots for model routing, credentials separated to auth.json)
- Background slot: cheap models for cron/heartbeat/summarization (haiku, gpt-5.4-mini)
- Anthropic OAuth fix: required "You are Claude Code" system prompt + beta headers
- Legacy config auto-normalization (backward compatible)
- 387 tests across 38 files

### Phase 10b: Quick Wins (#132)
- Sender name in session context: `Sender: Name (userId)` in context-builder for family chat identity (CR-AD)
- Incremental JSONL append + post-compaction truncation in session-manager (CR-AA)
- Subagent partial progress on timeout: returns collected work instead of bare "Stopped." (CR-AB)
- Cron run history `finished_at`: migration 9, cron_runs table enhancement (CR-AC)
- Exec env injection deny patterns: blocks JVM/Python/.NET/LD_PRELOAD/NODE_OPTIONS/Perl/Ruby env var injection (CR-AH)

### Phase 10c: MCP + Cloudflare + Multimodal (#133, #134)
- MCP schema normalization: strip unsupported JSON Schema keywords ($ref, oneOf, pattern, constraints) for OpenAI compatibility (CR-AI)
- Anti-Cloudflare retry in web_fetch: UA rotation, browser-like headers (Accept-Language, Sec-Fetch-*), 2s delay, escalation hint to browser tool (CR-AG)
- Multimodal tool results: ToolContentBlock[] (text + images), Anthropic native vision passthrough, OpenAI/Codex text fallback, `__MULTIMODAL__` prefix protocol, `toolResultWithImage()` helper (CR-AF)
- 400 tests across 39 files

### Phase 10d: Agent Hardening (#136)
- Cross-tool loop detection: 6-call pattern window detects repeating tool sequences, injects system break message (OD-A)
- MAX_ITERATIONS=200 hard safety limit on agent loop
- Proactive context overflow detection: checks token budget at 90% (prunes old tool results) and 95% (emergency compression) (CR-Q)
- Context pruning (pruneOldToolResults): tool results older than 8 messages trimmed to 200 chars (OD-B)
- Prompt injection guard: web_fetch and Jina output wrapped in `<untrusted_content source="url">` XML tags (item 44)
- Proactive OAuth token refresh: 30-min interval checks for tokens expiring within 1 hour, auto-refreshes anthropic/codex (OD-C)
- 400 tests across 39 files

### Phase 11: Multi-Agent Routing (#137, #138)
- AgentResolver: generic match bag routing with first-match-wins bindings, per-agent config (tools, params, model slots, bootstrap file overrides)
- Config: `agents[]` (AgentDefinitionSchema), `bindings[]` (BindingSchema), `defaultAgentId`
- Agent ID validation regex (`^[a-z0-9][a-z0-9_-]{0,63}$`)
- Per-agent: EGO.md, AGENTS.md, HEARTBEAT.md path overrides
- Per-agent: tool allow/deny (intersect allow, union deny with user), params (temperature, maxTokens), model slot overrides
- Agent-prefixed session keys (`{agentId}:{channel}:{chatId}`) with legacy auto-migration (self-healing)
- Per-agent memory isolation: `resolveMemDir` (agent > user > global when `memory.shared: false`), `ensureAgentDir()` creates `.janus/agents/{id}/memory/`
- Per-agent cron: agentId on cron_jobs (migration 10), propagated to inbound messages
- Per-agent heartbeat: HeartbeatService loads per-agent HEARTBEAT.md, syncs agentId to CronService
- Context builder: agent name in identity, `Agent:` line in session context, per-agent memory section
- Telegram routingMeta with topicId for forum supergroup routing
- Onboard creates `.janus/agents/` directory
- Zero-config backward compat (empty agents[] = implicit "main")
- 414 tests across 40 files

### Cross-User Cron Reminders (#146)
- `target_user_id` on cron tool: creates job owned by target user, records requester in task for notification
- Job ID in cron execution context: `(id: {jobId})` enables agent self-removal via `cron remove`
- Cron session context injection: last 10 messages from target user's primary session injected into cron context
- Solves: session isolation (cron didn't see confirmations), cross-user visibility, infinite reminder spam
- 433 tests across 41 files

### Security Hardening Sprint (#149)
- IPv6 SSRF guard: blocks private/reserved IPv6 ranges (fc00::/7, fe80::/10, ff00::/8) in addition to existing IPv4 guards
- Untrusted content tags on web_search: output wrapped in `<untrusted_content>` XML tags (already existed for web_fetch)
- Strict ownerIds: unknown userId no longer treated as owner in multi-user mode
- Secret redaction in tool results: masks `KEY=`, `Bearer`, `sk-`/`ghp_`/`AKIA`/JWT patterns before sending to LLM
- Token masking in logger: sensitive tokens masked in log output
- Exec master switch: `tools.execEnabled` config flag to disable exec tool entirely
- Credential encryption: AES-256-GCM for auth.json at rest
- Gate audit log: SQLite `gate_audit_log` table (migration 11) records all gate decisions

### Cron Targets Overhaul (#164-167)
- Multi-target delivery model: owner+targets[] replacing target_user_id. Per-target status (pending/confirmed/rejected), auto-disable on full response
- Recursion guard removed (cron jobs can create/modify other cron jobs)
- known_users with channel info in context builder
- Multi-target context injection (per-target status, max 3 pending targets, 5 msgs each)
- Auto-cleanup of old disabled cron jobs (configurable via cron.cleanup)
- Update command auto-adds new top-level config sections (merges janus.example.json into janus.json, add-only, backup to janus.json.bak)
- 466 tests across 42 files

### Phase 13: Distribution Overhaul (#174, #175, #177, #178, #179)
- Backup/restore/doctor commands (PR #174)
- Releases and versioning v1.0.0: CHANGELOG.md, GitHub release workflow with tarball asset (PR #175)
- Surrogate-safe string truncation (PR #177)
- Inbound image vision: Telegram photo passthrough to Claude/GPT vision (PR #178)
- Install scripts: Unix `curl | bash`, Windows PowerShell `irm | iex` (PR #179)
- Tarball update mode: `janus update` and `self_update` auto-detect git vs tarball, GitHub Releases API, backup/rollback (PR #179)
- Version utilities: `isNewerVersion()`, `getLatestRelease()`, `downloadFile()` (PR #179)
- 563 tests across 50 files

### Phase 14: Token Optimization (#181-185)
- Static/dynamic system prompt split for Anthropic cache (static part cached, dynamic uncached)
- Cache control on last user message (cache prefix sealing)
- Memory flush consolidated from 5 triggers to 3 (removed idle timer and count-based)
- Summarization quality retry removed (wasteful second LLM call)
- Background context mode for cron/heartbeat (skips memory/learner/HEARTBEAT/JANUS)
- `--token-debug` CLI flag for per-request token breakdown on stdout
- Heartbeat `- chat:` field support for group chat routing
- Anthropic SDK 0.77.0 → 0.90.0, fine-grained-tool-streaming beta, user-agent 2.1.104
- Diet tracker skill
- Version scheme: 1.0.0 → 0.14.0 (pre-stable)
- 597 tests across 53 files

### Phase 15: Context Management Redesign (#208-223)
- Single pre-call router in `context/context-manager.ts` (4 routes: fits / truncate_only / compact_only / compact_then_truncate) replacing Phase 1/2/3 budget passes + emergency cascade
- Transcript rotation on compaction (bounded on-disk sessions), unified tool result cap
- Pinned skill state, per-chat memory scoping (#220), file logging with daily rotation (#218)
- Update command config-section sync from janus.default.json (#219, #221, #222)

### Reliability: cron delivery hardening (#224-226)
- Root cause of the 2026-06-30 "no reminders" outage: a second half-dead gateway instance claimed cron jobs from the shared SQLite table and published them into a bus nobody consumed
- Lane watchdog (`agent.laneTimeoutMs`): hung run aborted + slot released, lanes can't wedge silently
- Queue telemetry: system-lane publishes log depth, warn on unconsumed pile-up; bus errors to file logger
- HEARTBEAT.md re-sync without restart (`heartbeat.resyncIntervalMs`), removed sections disable their jobs
- Cron/heartbeat memory scope: DM-delivered runs flush to `users/{id}/memory/`, groups stay per-chat
- Gateway instance lock (`.janus/gateway.pid`) + shutdown force-exit backstop (15s)

### Reliability: provider circuit breaker (#232-234)
- Bounded Telegram init (`telegram.initTimeoutMs`) so a Bot API outage can't block cron startup (#232)
- Embedding cache keyed by content hash — startup reindex no longer recomputes every chunk (#233)
- Provider circuit breaker (#234): after `llm.circuitBreaker.failureThreshold` failover-eligible failures a provider is skipped for `cooldownMs`; before this, an upstream incident cost the full retry ladder on every message
- Health keyed by `ProviderEntry.providerName`, so default + background slots sharing an upstream are demoted together; filter never returns an empty candidate list
- Auth errors (`authentication_error`/`invalid_api_key`) now fail over — credentials are per-provider

**Remaining:**
- Tool policy enforcement (domain filters, content rating) — schema exists, enforcement stubbed
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
- **Simplicity** — ~13.5K LOC. Minimal codebase, full capabilities.
- **Native OAuth** — PKCE flows for Anthropic + Codex. No CLI SDK dependency required.
- **Steering messages** — Mid-run user injection. User can redirect agent during tool execution.
- **Family skills** — Meal planner, Home Assistant, stock watcher, travel planner, Google Workspace.
