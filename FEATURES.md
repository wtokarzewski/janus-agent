# Features

Canonical list of implemented, working features. Verified against source code and 414 passing tests.

**Last updated:** 2026-03-22

---

## Agent Core

- **Flat agent loop** — LLM decides what to do, tools execute, loop repeats until done. No rigid pipeline or pre-classification.
- **Subagent spawning** — `spawn_agent` tool creates child AgentLoop with isolated session. Minimal prompt mode (identity + skills + session only) saves tokens. Partial progress on timeout: returns collected work instead of bare "Stopped." message.
- **Emergency compression** — On context overflow, drops oldest 50% of messages and retries (up to 2x).
- **Token-based summarization** — When session tokens exceed 75% of budget, triggers async summarization.
- **Memory flush before compaction** — Before summarization discards old messages, pointer-based flush extracts ALL discarded messages (lastFlushed..discardUpTo) with context-aware LLM extraction. Triple output: HISTORY.md + daily notes + MEMORY.md holistic update. Preserves knowledge across compaction.
- **No-op suppression** — Heartbeat/cron responses like "HEARTBEAT_OK" are not routed to the user.
- **LLM overload resilience** — 5-retry exponential backoff (1s→2s→4s→8s→16s), user notification on first retry, abort-aware sleep, clean error message after exhaustion.
- **SDK timeout hardening** — Anthropic/OpenAI SDK timeout reduced from 10 min to 2 min per request. Background LLM calls (flush, summarization) have 90s hard cap via `Promise.race`.
- **Graceful shutdown flush** — SIGTERM/SIGINT triggers session flush before abort (double-signal = force exit). `memoryFlushInterval` default lowered from 10 to 5 messages for more frequent persistence.
- **Diagnostic timing logs** — Full pipeline observability: Telegram incoming → lane semaphore → context build → LLM call → tool execution → flush → summarization, with durations.
- **Leaked control token stripping** — Sanitizes LLM control tokens (`<|endoftext|>`, `[INST]`, `<<SYS>>`, `<s>`) from user-facing output before delivery.
- **Invisible Unicode stripping** — Strips zero-width spaces, Mongolian vowel separators, and other invisible chars before gate/deny pattern checks. Prevents regex bypass.
- **MAX_ITERATIONS hard limit** — Safety cap at 200 iterations per agent loop run. Prevents infinite loops even when all other safeguards fail.
- **Cross-tool loop detection** — 6-call sliding window detects repeating tool call sequences (e.g., exec->fail->exec->fail). Injects system break message to redirect the agent.
- **Proactive context overflow detection** — Monitors token budget usage after each tool call. At 90%, prunes old tool results (`pruneOldToolResults`). At 95%, triggers emergency compression. Prevents mid-task crashes.
- **Context pruning (pruneOldToolResults)** — Tool results older than 8 messages automatically trimmed to 200 chars. Reclaims context space without waiting for emergency compression.
- **Compaction hardening** — Double-fire guard (no concurrent compaction on same session), post-compaction sanity check (verifies token reduction), task-aware summarization (preserves active task context).
- **Compaction notifications** — Silent background summarization with ⏳ status indicator.
- **SSRF guard** — Blocks private/reserved IPs (localhost, 10.x, 172.16-31.x, 192.168.x, link-local, cloud metadata) in web_fetch and browser tools.

## Multi-Agent

- **AgentResolver** — Generic match bag routing with first-match-wins bindings. Routes inbound messages to the correct agent based on channel, chatId, topicId, userId. Zero-config backward compat: empty `agents[]` = implicit "main" agent.
- **Config: agents[], bindings[], defaultAgentId** — `agents[]` defines agent personas (AgentDefinitionSchema). `bindings[]` maps match criteria to agents (BindingSchema). `defaultAgentId` fallback when no binding matches.
- **Agent ID validation** — Regex `^[a-z0-9][a-z0-9_-]{0,63}$` enforced at config parse time.
- **Per-agent bootstrap overrides** — Each agent can specify custom paths for EGO.md, AGENTS.md, HEARTBEAT.md. Falls back to global files when not configured.
- **Per-agent tool allow/deny** — Intersects allow lists (agent AND user), unions deny lists (agent OR user). Fine-grained tool access per persona.
- **Per-agent params** — Temperature, maxTokens overrides per agent definition.
- **Per-agent model slot overrides** — Agent-specific model routing (e.g., work agent uses opus, home agent uses sonnet).
- **Agent-prefixed session keys** — Format `{agentId}:{channel}:{chatId}`. Each agent maintains its own conversation history. Legacy session key auto-migration (self-healing: old keys transparently promoted to `main:` prefix).
- **Per-agent memory isolation** — `resolveMemDir` prefers agent > user > global memory directories when `memory.shared: false`. `ensureAgentDir()` auto-creates `.janus/agents/{id}/memory/`.
- **Per-agent cron jobs** — `agentId` field on cron_jobs table (migration 10). Propagated through CronJobInput to inbound messages. HeartbeatService loads per-agent HEARTBEAT.md and syncs agentId to CronService.
- **Telegram routingMeta** — Includes topicId for forum supergroup routing to correct agent.
- **Context builder integration** — Agent name in identity section, `Agent:` line in session context. Per-agent memory section via agentId when not shared.
- **Onboard** — Creates `.janus/agents/` directory structure.
- **14 tests** — agent-resolver.test.ts covers routing, bindings, fallback, migration, edge cases.

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

- **Native OAuth (PKCE)** — Browser-based login for Anthropic + Codex with auto-refresh. Credential storage (`~/.janus/auth.json`, 0o600) — both OAuth tokens and API keys. Proactive refresh: 30-min interval checks for tokens expiring within 1 hour via `getExpiringProviders()`, auto-refreshes before failover is needed.
- **Anthropic OAuth identity** — Injects required "You are Claude Code" system prompt + beta headers (`claude-code-20250219`, `oauth-2025-04-20`) for subscription OAuth tokens.
- **Extended thinking** — `llm.thinking.enabled` + `budgetTokens`. Thinking levels: off/minimal/low/medium/high.
- **Prompt caching** — `cache_control: ephemeral` on system prompt + last tool def. Timestamp in dynamic session tail for cache stability.
- **Multi-provider failover** — Priority-ordered providers, automatic failover on error. Purpose-based routing via slots (default, background). RESOURCE_EXHAUSTED/overload detection, rate-limit hardening (rate_limit, too many requests), HTTP 422 classification (billing vs format errors).
- **Providers + Slots config** — `providers` object (auth, priority per provider) + `slots` (default/background with per-provider model mapping). Credentials separated to `auth.json`. Legacy flat config auto-normalized at load time.
- **Background slot** — Cheap models for cron/heartbeat/summarization (e.g., claude-haiku, gpt-5.4-mini). Falls back to default slot when not configured.
- **toolChoice support** — `auto`/`none`/`required` with automatic fallback if provider rejects. Wired through Anthropic (required→any mapping) and OpenAI providers.
- **Dynamic model listing** — Setup wizard fetches models from provider APIs (Anthropic `/v1/models`, OpenAI `/v1/models`). Filters non-chat models from OpenAI. Falls back to manual input on fetch failure.
- **Multimodal tool results** — Tools can return images alongside text via `ToolContentBlock[]`. Anthropic provider passes image blocks natively to Claude vision. OpenAI/Codex providers flatten to text with image count note. `toolResultWithImage()` helper for tool authors.
- **Streaming** — `chatStream()` on Anthropic + OpenAI-compatible providers. Real-time chunk delivery via MessageBus to CLI and Telegram.
- **Structured output** — Subscription providers use JSON schema enforcement via `sdk-utils.ts` (~99% reliability + fallback parsing).
- **Setup wizard** — Interactive first-run config. Generates providers+slots format. Detects API key vs subscription. Fallback provider selection. `/config` command for reconfiguration.

## Tools (16)

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
| `web_fetch` | Fetch URLs (HTML→markdown, JSON, size/redirect guards, CAPTCHA detection, Jina Reader option, SSRF guard, anti-Cloudflare retry with UA rotation and browser-like headers, escalation hint to browser tool, prompt injection guard: output wrapped in `<untrusted_content>` XML tags). |
| `web_search` | Web search (Brave API or DuckDuckGo fallback, in-memory cache 15min TTL). |
| `browser` | **Real Chrome** via Playwright persistent context. AI-native snapshots with element refs. Auto-launches Chrome with dedicated profile. 30min idle timeout. Safety policy blocks checkout/payment. |
| `heartbeat` | Manage periodic heartbeat tasks. |
| `self_update` | Check/apply updates (git pull, npm install, test, self-respawn, auto-revert). |
| `invite` | Generate Telegram invite links for new user onboarding. |

### Tool Infrastructure

- **Tool registry** — Centralized tool registration with per-user allow/deny lists.
- **Owner-only tools** — `ownerOnly` flag on tool definitions. `ownerIds` in config (defaults to first user). Enforced in ToolRegistry + filtered from system prompt for non-owners.
- **Gate integration** — Pattern-based confirmation before destructive commands.
- **Context injection** — Tools receive workspace dir, chatId, userId, browser config.
- **Result truncation** — Tool output capped at 4000 chars.
- **Retry** — Automatic retry on tool failure (configurable, default 2x).

### Browser Operator

Real-browser automation via Playwright. Controls a dedicated Chrome profile through AI-native snapshots.

- **Architecture:** Agent → browser tool → Playwright persistent context → real Chrome
- **Snapshot engine** — Playwright `_snapshotForAI()` — AI-native ARIA snapshots with element refs (e1, e2, e3...), semantic roles, text content, URL annotations
- **Actions** — click, type, pressKey, scroll, navigate, waitFor (domStable, urlMatches, textVisible, elementExists) — all via `aria-ref` locators
- **Runtime** — State machine (idle→launching→ready→failed), Playwright manages Chrome lifecycle
- **Lifecycle** — Lazy start on first call, persistent context keeps cookies/sessions, closeBrowser for explicit shutdown, 30min idle auto-close
- **Safety** — Dangerous action text blocking (checkout, payment, buy now), read-only default policy
- **Cookie dismissal** — Structural overlay detection (no hardcoded text), largest-button heuristic
- **Config** — `browserOperator` section in janus.json (chromePath, profileDir, headless)

## Memory System

- **MEMORY.md** — Persistent knowledge file. Agent reads/writes via tools. Evergreen in search ranking. Holistically updated by memory flush (not just appended — rewritten with full context).
- **HISTORY.md** — Append-only conversation log. Memory flush appends session extracts chronologically.
- **Daily notes** — `memory/YYYY-MM-DD.md`. Auto-populated by memory flush. Part of triple output (HISTORY.md + daily notes + MEMORY.md).
- **Pointer-based flush tracking** — `lastFlushed` index per session, persisted in JSONL metadata. Ensures every message is flushed exactly once, no gaps or duplicates.
- **Context-aware extraction** — Flush prompt includes session summary + current MEMORY.md for informed extraction. LLM produces triple output: HISTORY.md entries, daily note entries, and holistic MEMORY.md update.
- **5 flush triggers** — Count-based (every `memoryFlushInterval` messages), token-aware (60% budget), pre-summarization (all discarded messages), idle (2 min, configurable `memoryIdleFlushMs`), shutdown.
- **FTS5 search** — SQLite full-text search with BM25 ranking.
- **Vector search** — Local embeddings via `@xenova/transformers` (all-MiniLM-L6-v2, 384-dim, ONNX). Zero API cost. Opt-in via `memory.vectorSearch` config.
- **Hybrid search (RRF)** — Reciprocal Rank Fusion combining FTS5 + vector results.
- **Temporal decay** — 30-day half-life. Recent content ranks higher. MEMORY.md chunks exempt (evergreen).
- **Scope filtering** — Memory chunks tagged with owner/scope for multi-user isolation.
- **Per-agent memory isolation** — `resolveMemDir` prefers agent > user > global memory directories when `memory.shared: false`. Agents maintain separate MEMORY.md, HISTORY.md, and daily notes.
- **Markdown chunking** — Split by `##` headings. Further split at paragraph boundaries when chunk exceeds 2000 chars.
- **Async reindex** — Embedding computation is non-blocking. Delayed 5s on startup with setImmediate yield points between inference calls to prevent event loop blocking.

## Channels (2 + MCP)

| Channel | Features |
|---------|----------|
| **CLI** | Interactive REPL, single-message mode (`-m`), persistent history (~/.janus/history), `/help`, `/config`, `/model`, `/stop` commands, inline streaming output, gate confirmation via readline. |
| **Telegram** | Grammy bot, user allowlist (denyByDefault), streaming via edit-in-place (500ms throttle), gate confirmation via inline keyboard, message splitting (4096 char limit), `/whoami`, `/stop`, `/model` commands, invite deep-link onboarding, drop pending updates on startup, markdown URL cleanup, forum/topic session isolation, group mention policy (`groupPolicy: all\|mention`), voice message transcription (Groq Whisper), message dedup (hash-based, 30s window). |
| **MCP Server** | JSON-RPC 2.0 over stdio. Exposes tools and prompts to editors (VS Code, Cursor, Claude Code). Tool bridge maps ToolRegistry to MCP protocol. |
| **MCP Client** | Connect to external MCP servers. Config-driven `mcp.servers[]`. Auto-discover tools, register as `mcp_{server}_{tool}`. Schema normalization strips unsupported JSON Schema keywords for OpenAI compatibility. |

## Gates (Safety)

- **PatternGate** — Regex-based confirmation before destructive `exec` commands.
- **Default patterns:** `rm`, `git push`, `git reset`, `npm publish`, `docker rm`.
- **CLIGate** — Readline yes/no confirmation. 30s timeout (auto-deny).
- **TelegramGate** — Inline keyboard (Approve / Deny) confirmation. 60s timeout (auto-deny).
- **Wired into ToolRegistry** — Gate check runs before every tool execution.
- **Path validation** — `realpathSync()` + workspace prefix check on all file tools. Symlink safety. Cross-platform (`path.sep`). User-scoped access enforcement in family chats (users can only access their own `.janus/users/{id}/` directory).
- **Obfuscation detection** — 8 patterns (base64 pipe, xxd, eval, etc.) + whitelist in PatternGate. URL stripping before check (prevents false positives from URLs containing "bash").
- **Env injection deny patterns** — Blocks environment variable injection vectors: JVM (`JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`), Python (`PYTHONSTARTUP`, `PYTHONPATH`), .NET (`DOTNET_STARTUP_HOOKS`), `LD_PRELOAD`, `NODE_OPTIONS`, Perl (`PERL5OPT`), Ruby (`RUBYOPT`).
- **Gate on file writes** — 11 sensitive path patterns (/etc, .ssh, .env, .git/config, etc.).
- **Gate on spawn_agent** — Always gated with task preview.
- **Process group kill** — `spawn({detached:true})` + `kill(-pid)` on exec timeout.

## Scheduling

- **CronService** — SQLite-backed persistent scheduler. Survives restarts.
  - 3 schedule kinds: `at` (one-shot), `every` (interval), `cron` (expression via croner).
  - Timezone support for cron expressions.
  - Run history tracking with `finished_at` timestamps (migration 9), exponential backoff on consecutive errors (30s → 60s → 5m → 15m → 1h).
  - Missed job staggering: jobs >1 min late after restart spread 30s apart to prevent LLM overload.
  - Per-user job ownership: userId column (migration 6), ownership enforcement on update/delete/list.
  - Per-agent jobs: agentId column (migration 10), propagated to inbound messages.
  - Custom session IDs: optional sessionId per cron job — reuse same session across runs (migration 7).
  - CRUD: addJob, updateJob, removeJob, listJobs, getRuns.
- **HeartbeatService** — Parses `HEARTBEAT.md` for periodic tasks.
  - Supports `every Xm/h/d` and cron expressions.
  - Per-user `HEARTBEAT.md` in `.janus/users/{userId}/` — tasks tagged with userId, routed to user's Telegram chat.
  - Per-agent `HEARTBEAT.md` in `.janus/agents/{agentId}/` — loads per-agent tasks, syncs agentId to CronService.
  - Auto-starts when any HEARTBEAT.md exists (global, per-user, or per-agent).
  - Syncs to CronService when available, falls back to in-memory timers.

## Multi-User

- **UserResolver** — Resolves inbound message sender to user profile by channel + ID (stable) or username (fallback). Auto-creates `.janus/users/{id}/` with default PROFILE.md on first resolution (`ensureUserDir()`, channel-agnostic).
- **Per-user profiles** — `.janus/users/{userId}/PROFILE.md` (workspace). Auto-updated by agent when learning user preferences.
- **Per-user AGENTS.md** — `.janus/users/{userId}/AGENTS.md` overrides global agent behavior. Appended to global AGENTS.md in system prompt.
- **Per-user HEARTBEAT.md** — `.janus/users/{userId}/HEARTBEAT.md` for personal scheduled tasks. Routed to user's Telegram chat.
- **Per-user memory** — Scoped memory chunks (owner + scope filtering in MemoryIndex).
- **Family groups** — Shared memory scope via `family.groupChatIds` config.
- **Per-user cron jobs** — Cron jobs scoped to owner (userId column, migration 6). Ownership enforcement on update/delete/list operations.
- **File access control** — validatePath enforces user-scoped access in family chats. Users can only access their own `.janus/users/{id}/` directory, preventing cross-user file access.
- **Chat directories** — `ensureChatDir()` creates per-chat dirs (`.janus/chats/{chatId}/`) for chat-scoped storage.
- **Context isolation** — System prompt scoped per-user in family chats to prevent information leakage between users.
- **DB hardening** — Exec deny patterns block direct `sqlite3` CLI access to prevent database tampering.
- **Wired into AgentLoop** — User profile passed to context builder, tool context, learner.

## Invite Links

- **InviteStore** — In-memory token store with 24h TTL. Tokens are base64url (16 chars).
- **Deep links** — `https://t.me/BOT?start=invite_TOKEN`. New user clicks → `/start invite_TOKEN` → auto-added to allowlist + config.users.
- **Persistence** — Invited users saved to `janus.json` (both `config.users` and `telegram.allowlist`). Per-user directory auto-created.
- **Non-blocking** — Fire-and-forget `ctx.reply()` prevents invite handler from blocking grammY pipeline.
- **Markdown cleanup** — `cleanMarkdownUrls()` strips `**`/`*`/`__`/`_` from URLs before sending to Telegram.

## Learner

- **Execution metrics** — Records task, duration, iterations, tool calls, token usage, outcome per agent run.
- **SQLite storage** (primary) with JSONL fallback.
- **Keyword similarity** — Finds similar past tasks by keyword overlap.
- **Recommendations** — Returns avgDuration, avgIterations, avgToolCalls, successRate from similar executions. Wired into system prompt via context builder.

## Skills (9)

- **SKILL.md format** — YAML frontmatter (name, description, version, always, requires) + markdown body.
- **3-source loading** — workspace/skills → ~/.janus/skills → builtin/skills.
- **Lazy loading** — Skills emit XML stubs with `location` attribute. Agent reads full content on demand via `read_file`. `always: true` skills inlined in system prompt.
- **Per-user filtering** — Skills filtered by user allow/deny lists.
- **Config limits** — `maxSkillsInPrompt`, `maxSkillsPromptChars`.
- **Skill self-creation** — System prompt instructs agent to create SKILL.md for repeated patterns. Meta-skill `skill-creator` with `always: true`.
- **Mtime-based cache invalidation** — Skills reloaded when source file mtime changes. Avoids stale cache after skill edits.

| Skill | Description |
|-------|-------------|
| `programmer` | Software development, debugging, code review. Always loaded. |
| `meal-planner` | Weekly meal planning, dietary restrictions, shopping lists. |
| `home-assistant` | Home Assistant REST API control (lights, climate, scenes, scripts). |
| `stock-watcher` | Google Finance watchlist, Python scripts, multi-exchange. |
| `google-workspace` | Gmail, Calendar, Drive, Contacts, Sheets, Docs via `gog` CLI. |
| `personal-travel` | Travel planning, documents, wishlists, budgets. |
| `github` | GitHub operations via `gh` CLI: repos, issues, PRs, CI, releases, gists, search. |
| `skill-creator` | Meta-skill for creating new SKILL.md files from repeated task patterns. |
| `browser-operator` | Real browser automation guide — workflow patterns, snapshot interpretation, rules, error recovery. |

## Sessions

- **JSONL persistence** — Incremental append (new messages appended, not full rewrite). Post-compaction truncation reclaims disk space. First line = metadata.
- **Agent-prefixed session keys** — Format `{agentId}:{channel}:{chatId}`. Each agent maintains isolated conversation history. Legacy key auto-migration (self-healing).
- **Memory cache** — In-memory + file for performance.
- **Summarization** — Async, non-blocking. Split-half strategy: keep last 4 messages, summarize the rest.
- **Crash recovery** — Orphan tool messages stripped on load.

## Context Builder

Assembles system prompt from multiple sources:

| # | Section | Source | In minimal mode |
|---|---------|--------|-----------------|
| 1 | Identity | Built-in (date, workspace, available tools) | Yes |
| 2 | User profile | Per-user PROFILE.md | Yes |
| 3 | Ego | `~/.janus/EGO.md` | No |
| 4 | Agents | `./AGENTS.md` + per-user override | No |
| 5 | Heartbeat | `./HEARTBEAT.md` + per-user override | No |
| 6 | Project | `./JANUS.md` | No |
| 7 | Skills | SKILL.md files (lazy stubs or full body) | Yes |
| 8 | Memory | FTS5 + vector hybrid search with scope filtering | No |
| 9 | Learner | Recommendations from similar past executions | No |

Subagents use minimal mode (identity + user + skills only) to save tokens.

- **Sender name in session context** — Shows `Sender: Name (userId)` instead of `User: userId` in family chats. Agent knows WHO is writing, enabling proper identity-aware responses ("remind me" knows who to remind).
- **Agent identity in context** — Agent name in identity section, `Agent:` line in session context. Per-agent memory section via agentId when not shared.
- **All behavioral instructions externalized to AGENTS.md** — context-builder code has zero hardcoded rules. All tool usage rules, skill instructions, and behavioral guidance live in editable .md files.
- **Date-only timestamp** — ISO date (no time) in session info maximizes Anthropic prompt cache hits within a day.

## Bootstrap Files

| File | Scope | Purpose |
|------|-------|---------|
| `~/.janus/EGO.md` | Global | Agent character and personality |
| `~/.janus/chrome-profile/` | Global | Dedicated Chrome profile for Browser Operator |
| `./JANUS.md` | Per-repo | Project-specific instructions (like CLAUDE.md) |
| `./AGENTS.md` | Per-workspace | Agent behavior rules (all behavioral instructions live here) |
| `./HEARTBEAT.md` | Per-workspace | Autonomous periodic tasks |
| `.janus/users/{id}/PROFILE.md` | Per-user | User preferences and identity |
| `.janus/users/{id}/AGENTS.md` | Per-user | Agent behavior override (appended to global) |
| `.janus/users/{id}/HEARTBEAT.md` | Per-user | Personal scheduled tasks (routed to user's chat) |
| `.janus/chats/{chatId}/` | Per-chat | Chat-scoped directory (auto-created) |
| `.janus/agents/{id}/` | Per-agent | Agent directory with optional EGO.md, AGENTS.md, HEARTBEAT.md overrides + `memory/` for isolated memory |

## Database

- **SQLite** (better-sqlite3), WAL mode, numbered migrations.
- **10 migrations:** memory_chunks + FTS5, learner_records, cron_jobs + cron_runs, embedding column, multi-user columns (owner, scope, scope_id), per-user cron (user_id column), cron session IDs (session_id column), cron chat_id column, cron_runs finished_at column, cron_jobs agent_id column.
- **Memory write validation** — Verify write succeeded by reading back. After 3 consecutive failures, dump to timestamped backup file.
- **Graceful fallback** — File-based storage when database disabled.

## Configuration

`janus.json` (workspace) + `~/.janus/config.json` (user) + env vars. Zod-validated. Credentials in `.janus/auth.json` (separated from config).

| Section | Key settings |
|---------|-------------|
| `llm` | providers (object), slots (default/background), maxTokens, temperature (default 0.3), thinking, reasoningEffort |
| `agent` | maxIterations (30), tokenBudget (750K), contextWindow (1M), summarizationThreshold (40), toolRetries, lanes |
| `workspace` | dir, memoryDir, sessionsDir, skillsDir |
| `tools` | execTimeout, execDenyPatterns[], maxFileSize |
| `database` | enabled, path |
| `heartbeat` | enabled, checkIntervalMs |
| `telegram` | enabled, token, allowlist[], denyByDefault (true), groupPolicy (all\|mention) |
| `streaming` | enabled, telegramThrottleMs |
| `gates` | enabled, execPatterns[] |
| `voice` | enabled, provider (groq), apiKey, language, maxDurationSec |
| `memory` | vectorSearch, vectorWeight, textWeight, recentDays |
| `browserOperator` | chromePath, profileDir, headless |
| `users[]` | id, name, identities[], tools{allow,deny}, skills{allow,deny} |
| `ownerIds` | User IDs with elevated privileges (owner-only tools) |
| `family` | id, name, groupChatIds[] |
| `agents[]` | id, name, ego/agents/heartbeat path overrides, tools{allow,deny}, params{temperature,maxTokens}, slots |
| `bindings[]` | agentId, match{channel,chatId,topicId,userId} |
| `defaultAgentId` | Fallback agent when no binding matches |

Load priority: defaults < user config < workspace config < env vars.

**Config hot reload** — `watchConfig()` watches janus.json + .janus/config.json with 500ms debounce. Changes take effect without restart in gateway mode.

## Infrastructure

- **MessageBus** — AsyncQueue with bounded capacity (100) and backpressure. Multi-lane concurrent processing (user:3, cron:1, heartbeat:1) with semaphore-based concurrency control and AbortSignal support. Steering message buffering during processing.
- **Shared bootstrap** — `createApp()` in `bootstrap.ts` eliminates duplication between CLI and gateway.
- **Docker** — Multi-stage Dockerfile (node:20-bookworm), docker-compose.yml.
- **CI** — GitHub Actions (typecheck + vitest on push/PR).
- **Tests** — 414 tests across 40 files (vitest, mock LLM, in-memory SQLite). Windows-compatible (conditional skip for symlink/permission tests).

## Commands

```bash
npm start                    # Interactive CLI
npm start -- -m "message"   # Single message mode
npm start -- gateway        # Headless mode (Telegram + services)
npm start -- onboard        # Initialize workspace + per-user dirs
npm start -- update          # Pull + install + test + per-user dirs
npm start -- mcp-server     # MCP server (stdin/stdout JSON-RPC)
npm start -- setup          # Configure LLM provider
```
