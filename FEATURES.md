# Features

Canonical list of implemented, working features. Verified against source code and 597 passing tests.

**Last updated:** 2026-04-20

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
- **SSRF guard** — Blocks private/reserved IPs (localhost, 10.x, 172.16-31.x, 192.168.x, link-local, cloud metadata) and IPv6 private ranges (fc00::/7, fe80::/10, ff00::/8) in web_fetch and browser tools.
- **Secret redaction in tool results** — Automatically masks secrets in tool output before sending to LLM: `KEY=`, `Bearer`, `sk-`/`ghp_`/`AKIA`/JWT patterns replaced with `[REDACTED]`.
- **Token masking in logger** — Sensitive tokens and keys masked in log output to prevent credential leakage in logs.
- **File logging (daily rotation)** — Opt-in mirroring of terminal output to daily files (`.janus/logs/YYYY-MM-DD.log`, same content minus ANSI colors, secrets masked). Configurable via `logging.file` (`enabled`, `dir`, `retentionDays`); old files auto-pruned on startup. Enables post-hoc debugging when running headless.
- **Strict ownerIds** — Unknown userId is never treated as owner in multi-user mode. Only explicitly listed `ownerIds` have elevated privileges.

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

- **Native OAuth (PKCE)** — Refresh is single-flight per provider (refresh tokens are single-use; concurrent lanes + the 30-min sweep used to fire several exchanges with the same token and lose all but one to `invalid_grant`), and a refresh rejected while another process rotated the token adopts the stored one. A genuinely dead credential logs at error level and DMs the owner once per process instead of a warn line every 30 min. Browser-based login for Anthropic + Codex with auto-refresh. Credential storage (`~/.janus/auth.json`, 0o600) — both OAuth tokens and API keys. Proactive refresh: 30-min interval checks for tokens expiring within 1 hour via `getExpiringProviders()`, auto-refreshes before failover is needed.
- **Credential encryption** — AES-256-GCM encryption for `auth.json` at rest. Transparent encrypt/decrypt on read/write.
- **Anthropic OAuth identity** — Injects required "You are Claude Code" system prompt + beta headers (`claude-code-20250219`, `oauth-2025-04-20`) for subscription OAuth tokens. Impersonated `user-agent: claude-cli/2.1.195`.
- **Model catalog** — current models only, no historical entries. `claude-agent` alias map: `opus`→`claude-opus-5`, `sonnet`→`claude-sonnet-5`, `haiku`→`claude-haiku-4-5-20251001`, `fable`→`claude-fable-5`, plus explicit pins `opus-5`/`sonnet-5`/`fable-5`. Superseded releases stay reachable by full model ID. Default slot ships `claude-sonnet-5`. `anthropic` API-key provider takes full model IDs. `modelRejectsSamplingParams()` omits `temperature`/`top_p`/`top_k` for every model that rejects them (Opus 5/4.8/4.7, Sonnet 5, Fable, Mythos) — a compatibility guard, kept for superseded IDs too.
- **Setup wizard model lists** — Anthropic subscription menu offers sonnet 5 / opus 5 / haiku 4.5 / fable 5; Codex menu offers GPT-5.6 Terra (default) / Sol / Luna plus gpt-5.5. Defaults sit on the balanced tier, not the flagship. API-key providers fetch the live list from the provider API; these lists are the offline fallback and the prompt default.
- **Sampling-param gating** — `modelRejectsSamplingParams()` omits `temperature`/`top_p`/`top_k` for models that reject them with a 400 (Opus 4.7/4.8, Sonnet 5, Fable, Mythos); Opus 4.6 / Sonnet 4.6 and older still receive `temperature`.
- **Extended thinking** — `llm.thinking.enabled` + `budgetTokens`. Thinking levels: off/minimal/low/medium/high.
- **Prompt caching** — Static/dynamic system prompt split: stable content (identity, EGO, AGENTS, HEARTBEAT, JANUS, skills) cached via `cache_control: ephemeral`, dynamic content (session info, memory, learner, summary) sent uncached. Cache breakpoints on last user message and tool definitions. `fine-grained-tool-streaming` beta enabled.
- **Multi-provider failover** — Priority-ordered providers, automatic failover on error. Purpose-based routing via slots (default, background). RESOURCE_EXHAUSTED/overload detection, rate-limit hardening (rate_limit, too many requests), HTTP 422 classification (billing vs format errors), typed auth errors (credentials are per-provider).
- **Provider circuit breaker** — A provider that fails repeatedly is skipped for a cooldown instead of being retried first on every message (`llm.circuitBreaker`: `failureThreshold` 2, `cooldownMs` 5 min, `enabled: false` to switch off). Health is keyed by the config provider name, so default and background slots sharing an upstream are demoted together; only failover-eligible errors count, and if every provider is open the full list is used anyway. Recovery is automatic — cooldown expiry doubles as the health probe.
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
| `web_search` | Web search (Brave API or DuckDuckGo fallback, in-memory cache 15min TTL, prompt injection guard: output wrapped in `<untrusted_content>` XML tags). |
| `browser` | **Real Chrome** via Playwright persistent context. AI-native snapshots with element refs. Auto-launches Chrome with dedicated profile. 30min idle timeout. Safety policy blocks checkout/payment. |
| `heartbeat` | Manage periodic heartbeat tasks. |
| `self_update` | Check/apply updates. Git mode: git pull + npm install + test + self-respawn + auto-revert. Tarball mode: GitHub Releases API + download + backup/rollback. |
| `invite` | Generate Telegram invite links for new user onboarding. |

### Tool Infrastructure

- **Tool registry** — Centralized tool registration with per-user allow/deny lists.
- **Exec master switch** — `tools.execEnabled` config flag disables exec tool entirely when set to `false`. Overrides all other exec permissions.
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

- **Per-chat memory scoping** — Episodic memory (MEMORY.md + daily notes) is scoped by conversation: group/channel chats → `.janus/chats/{chatId}/memory/` (shared within the chat), direct/personal messages → `.janus/users/{userId}/memory/`, isolated agents → `.janus/agents/{agentId}/memory/`. `scopeForChat()` picks the key (the scope is NOT always the chat — DMs key by user). Both read paths — direct `getContext` and FTS5/vector `search` — scope strictly to the resolved key, so one chat's memory never bleeds into another (e.g. a dedicated "diet" chat stays out of the main chat). `PROFILE.md` stays per-user (stable facts, always loaded).
- **MEMORY.md** — Persistent knowledge file. Agent reads/writes via tools. Evergreen in search ranking. Holistically updated by memory flush (not just appended — rewritten with full context).
- **HISTORY.md** — Append-only conversation log. Memory flush appends session extracts chronologically.
- **Daily notes** — `memory/YYYY-MM-DD.md`. Auto-populated by memory flush. Part of triple output (HISTORY.md + daily notes + MEMORY.md).
- **Pointer-based flush tracking** — `lastFlushed` index per session, persisted in JSONL metadata. Ensures every message is flushed exactly once, no gaps or duplicates.
- **Context-aware extraction** — Flush prompt includes session summary + current MEMORY.md for informed extraction. LLM produces triple output: HISTORY.md entries, daily note entries, and holistic MEMORY.md update.
- **3 flush triggers** — Token-aware (40% budget), pre-summarization (all discarded messages), shutdown.
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
- **Gate audit log** — All gate decisions (approve/deny/timeout) logged to SQLite `gate_audit_log` table (migration 11). Provides accountability trail for destructive operations.

## Scheduling

- **CronService** — SQLite-backed persistent scheduler. Survives restarts.
  - 3 schedule kinds: `at` (one-shot), `every` (interval), `cron` (expression via croner).
  - Timezone support for cron expressions.
  - Run history tracking with `finished_at` timestamps (migration 9), exponential backoff on consecutive errors (30s → 60s → 5m → 15m → 1h).
  - Missed job staggering: jobs >1 min late after restart spread 30s apart to prevent LLM overload.
  - Per-user job ownership: userId column (migration 6), ownership enforcement on update/delete/list.
  - Per-agent jobs: agentId column (migration 10), propagated to inbound messages.
  - Custom session IDs: optional sessionId per cron job — reuse same session across runs (migration 7).
  - Multi-target delivery: `targets[]` parameter with CronTarget[] (userId/chatId per target, pending/confirmed/rejected status). Replaces legacy `target_user_id`.
  - Auto-disable: jobs automatically disabled when all user targets have responded (code-level guarantee).
  - Target self-reject: `cron remove` on a target sets status=rejected instead of deleting the job.
  - Owner-only update: only job owner can update/delete. Privacy filtering in list/status for targets.
  - Recursion guard removed: cron jobs can now create/modify other cron jobs.
  - Stale nextRunAt recompute on startup: fixes jobs that missed their window during downtime.
  - Multi-target context injection: per-target status, max 3 pending targets, 5 messages each from target's primary session injected into cron execution context.
  - Startup migration for legacy `target_user_id` jobs: auto-converts to new targets[] format.
  - Auto-cleanup of old disabled jobs: configurable via `cron.cleanup` (enabled, intervalDays, time, maxAgeDaysOneShot, maxAgeDaysRecurring). Runs on startup + periodically.
  - Job ID in execution context: `(id: {jobId})` in cron message enables agent self-removal via `cron remove`.
  - CRUD: addJob, updateJob, removeJob, listJobs, getRuns.
  - **chat_id structural default** — when the agent calls `cron add` without `chat_id`, the tool inherits `reqCtx.chatId` so the reminder lands in the chat where the request was made. Synthetic Janus contexts (chatId starting with `cron:` / `system:`) are excluded so a job that spawns another job doesn't carry an internal routing token. The defaulting is reported in the response as `_chatIdDefaulted`. Channel-agnostic — works for any chat ID format the adapter publishes.
  - **`cron runs` clarity** — response wrapped with `_note` that spells out what `durationMs` (publish-to-bus only, not agent runtime) and `status:"ok"` (trigger fired, not delivery confirmed) actually mean. Prevents the agent from misreading a 1ms publish time as "the job did nothing."
- **HeartbeatService** — Parses `HEARTBEAT.md` for periodic tasks.
  - Supports `every Xm/h/d` and cron expressions.
  - Per-user `HEARTBEAT.md` in `.janus/users/{userId}/` — tasks tagged with userId, routed to user's Telegram chat.
  - Per-agent `HEARTBEAT.md` in `.janus/agents/{agentId}/` — loads per-agent tasks, syncs agentId to CronService.
  - Auto-starts when any HEARTBEAT.md exists (global, per-user, or per-agent).
  - Supports `- chat:` field for group chat routing (chatId passed through to CronService).
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

## Skills (10)

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
| `google-workspace` | Gmail, Calendar, Drive, Contacts, Sheets, Docs via `gws` CLI (googleworkspace/cli). |
| `personal-travel` | Travel planning, documents, wishlists, budgets. |
| `github` | GitHub operations via `gh` CLI: repos, issues, PRs, CI, releases, gists, search. |
| `skill-creator` | Meta-skill for creating new SKILL.md files from repeated task patterns. |
| `browser-operator` | Real browser automation guide — workflow patterns, snapshot interpretation, rules, error recovery. |
| `diet-tracker` | Diet tracking — meals, calories/macros, weigh-ins, daily summaries, weekly reports. |

## Sessions

- **JSONL persistence** — Incremental append (new messages appended, not full rewrite). Post-compaction truncation reclaims disk space. First line = metadata.
- **Agent-prefixed session keys** — Format `{agentId}:{channel}:{chatId}`. Each agent maintains isolated conversation history. Legacy key auto-migration (self-healing).
- **Memory cache** — In-memory + file for performance.
- **Summarization** — Async, non-blocking. Split-half strategy: keep last 4 messages, summarize the rest.
- **Crash recovery** — Orphan tool messages stripped on load.

## Context Builder

Assembles system prompt from multiple sources:

| # | Section | Source | Part | full | background | minimal |
|---|---------|--------|------|------|------------|---------|
| 1 | Identity | Built-in (workspace, tools) | Static | Yes | Yes | Yes |
| 2 | User profile | Per-user PROFILE.md | Dynamic | Yes | Yes | Yes |
| 3 | Ego | `~/.janus/EGO.md` | Static | Yes | Yes | No |
| 4 | Agents | `./AGENTS.md` + per-user override | Static | Yes | Yes | No |
| 5 | Heartbeat | `./HEARTBEAT.md` + per-user override | Static | Yes | No | No |
| 6 | Project | `./JANUS.md` | Static | Yes | No | No |
| 7 | Skills | SKILL.md files (lazy stubs or full body) | Static | Yes | Yes | Yes |
| 8 | Memory | FTS5 + vector hybrid search with scope filtering | Dynamic | Yes | No | No |
| 9 | Learner | Recommendations from similar past executions | Dynamic | Yes | No | No |
| 10 | Session | Date, time, channel, sender, agent, scope | Dynamic | Yes | Yes | Yes |
| 11 | Summary | Previous session summary | Dynamic | Yes | Yes | Yes |

Static part cached via Anthropic prompt caching (`cache_control: ephemeral`). Dynamic part sent uncached.
Subagents use minimal mode. Cron/heartbeat use background mode.

- **Sender name in session context** — Shows `Sender: Name (userId)` instead of `User: userId` in family chats. Agent knows WHO is writing, enabling proper identity-aware responses ("remind me" knows who to remind).
- **Agent identity in context** — Agent name in identity section, `Agent:` line in session context. Per-agent memory section via agentId when not shared.
- **known_users with channel info** — User identities in context include channel info (channel:channelUserId per user identity) for precise cross-channel targeting.
- **All behavioral instructions externalized to AGENTS.md** — context-builder code has zero hardcoded rules. All tool usage rules, skill instructions, and behavioral guidance live in editable .md files.
- **Timestamp in dynamic part** — Date and time in session info (dynamic, uncached) while identity section (static, cached) has no timestamp. Maximizes Anthropic prompt cache hits across requests.

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
- **13 migrations:** memory_chunks + FTS5, learner_records, cron_jobs + cron_runs, embedding column, multi-user columns (owner, scope, scope_id), per-user cron (user_id column), cron session IDs (session_id column), cron chat_id column, cron_runs finished_at column, cron_jobs agent_id column, gate_audit_log table, not_before on cron_jobs, cron targets column.
- **Memory write validation** — Verify write succeeded by reading back. After 3 consecutive failures, dump to timestamped backup file.
- **Graceful fallback** — File-based storage when database disabled.

## Configuration

`janus.json` (workspace) + `~/.janus/config.json` (user) + env vars. Zod-validated. Credentials in `.janus/auth.json` (separated from config).

| Section | Key settings |
|---------|-------------|
| `llm` | providers (object), slots (default/background), maxTokens, temperature (default 0.3), thinking, reasoningEffort (none/low/medium/high/xhigh/max) |
| `agent` | maxIterations (30), tokenBudget (750K), contextWindow (1M), summarizationThreshold (40), toolRetries, lanes, laneTimeoutMs (600000) |
| `workspace` | dir, memoryDir, sessionsDir, skillsDir |
| `tools` | execEnabled, execTimeout, execDenyPatterns[], maxFileSize |
| `database` | enabled, path |
| `heartbeat` | enabled, checkIntervalMs, resyncIntervalMs (60000) |
| `telegram` | enabled, token, allowlist[], denyByDefault (true), groupPolicy (all\|mention) |
| `streaming` | enabled, telegramThrottleMs |
| `gates` | enabled, execPatterns[] |
| `voice` | enabled, provider (groq), apiKey, language, maxDurationSec |
| `memory` | vectorSearch, vectorWeight, textWeight, recentDays |
| `cron` | cleanup (enabled, intervalDays, time, maxAgeDaysOneShot, maxAgeDaysRecurring) |
| `browserOperator` | chromePath, profileDir, headless |
| `users[]` | id, name, identities[], tools{allow,deny}, skills{allow,deny} |
| `ownerIds` | User IDs with elevated privileges (owner-only tools) |
| `family` | id, name, groupChatIds[] |
| `agents[]` | id, name, ego/agents/heartbeat path overrides, tools{allow,deny}, params{temperature,maxTokens}, slots |
| `bindings[]` | agentId, match{channel,chatId,topicId,userId} |
| `defaultAgentId` | Fallback agent when no binding matches |

Load priority: defaults < user config < workspace config < env vars.

**Config hot reload** — `watchConfig()` watches janus.json + .janus/config.json with 500ms debounce. Changes take effect without restart in gateway mode.

**Timezone** — Configurable via `timezone` field in janus.json (IANA format, e.g. `"Europe/Warsaw"`). Auto-detected from system if omitted. Used for all user-facing dates (system prompt, cron/heartbeat messages, daily memory notes, HISTORY.md timestamps). Setup wizard confirms detected timezone. Update command auto-backfills missing timezone in existing configs.

## Infrastructure

- **MessageBus** — AsyncQueue with bounded capacity (100) and backpressure. Multi-lane concurrent processing (user:6, cron:3, heartbeat:2) with semaphore-based concurrency control and AbortSignal support. Steering message buffering during processing. System-lane publishes log queue depth and warn when messages pile up with no waiting consumer (wedge detection). Dispatcher failures go through the file logger.
- **Lane watchdog** — Per-run timeout (`agent.laneTimeoutMs`, default 10 min): a run that never settles is aborted and its concurrency slot released, so a hung run can never wedge a lane into silently dropping cron/heartbeat messages.
- **Heartbeat re-sync** — HEARTBEAT.md files are re-checked for edits (`heartbeat.resyncIntervalMs`, default 60s, mtime polling): added sections become cron jobs and removed sections disable their jobs, without a restart.
- **Gateway instance lock** — `.janus/gateway.pid` prevents two gateways from running against one workspace (shared cron table = jobs claimed by a half-dead instance = silently lost reminders). Stale locks (dead pid) are taken over; a live holder is waited on ~30s (self_update respawn overlap) then startup is refused. Shutdown force-exits after 15s if teardown hangs.
- **Cron/heartbeat memory scope** — System runs delivered to a user's DM (chatId matches a channel identity) flush memory to `users/{id}/memory/`; group-chat runs keep per-chat scope (`chats/{chatId}/memory/`).
- **Shared bootstrap** — `createApp()` in `bootstrap.ts` eliminates duplication between CLI and gateway.
- **Docker** — Multi-stage Dockerfile (node:20-bookworm), docker-compose.yml.
- **CI** — GitHub Actions (typecheck + vitest on push/PR).
- **Tests** — 744 tests across 68 files (vitest, mock LLM, in-memory SQLite). Windows-compatible (conditional skip for symlink/permission tests).
- **Install scripts** — One-liner installers for non-git users. Unix (`curl | bash`): downloads latest GitHub Release tarball, extracts to `~/.janus-agent/`, creates `janus` launcher in `~/.local/bin`. Windows (PowerShell `irm | iex`): extracts to `%LOCALAPPDATA%\janus-agent\`, creates `janus.cmd` launcher, adds to user PATH. Both: prerequisite checks (Node.js 20+, npm), backup of existing install.
- **Tarball update mode** — `janus update` and `self_update` tool auto-detect install mode: git (`.git/` exists) uses `git pull` flow, tarball (no `.git/`) downloads latest GitHub Release with backup/rollback on failure. Version comparison via `isNewerVersion()` semver utility.

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
