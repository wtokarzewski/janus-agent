# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

Janus is a universal AI agent. CLI + Telegram + Browser Operator, ~17,500 lines TypeScript.

**Name:** Janus — Roman god of beginnings, transitions, and duality. Two faces looking to the past and the future. Reflects the agent's dual nature: planning vs execution, analysis vs implementation, AI vs human control.

**Status:** OAuth refresh failover + error classification fix — an expired Anthropic refresh token (`Token refresh failed (400): {"error": "invalid_grant"}`) exposed three defects at once: (1) `isFailoverCandidate()` matched only `invalid_api_key`/`authentication_error`, so the refresh failure fell through to the generic 4xx rule → **no failover to codex**, no circuit-breaker demotion; (2) agent-loop's context-overflow heuristic was `/token|context|length|too long/i`, and the word "**Token** refresh failed" matched → two wasted hard-clears of tool results per message; (3) its `isClientError` regex didn't match the `(400)` wrapper shape, so a permanently dead credential burned the full 5-retry backoff ladder (~34s) and then failed summarization too. Fixes: new exported `isContextLengthError()` + `isNonRetryableClientError()` in `src/llm/retry.ts` (narrow, pattern-list based, both unit-tested against verbatim production strings), used by agent-loop instead of inline regexes; `isFailoverCandidate()` also matches `invalid_grant` / `token refresh failed`, and now returns `false` for context-length errors before the `invalid_request` branch (they can't succeed on another provider and must not demote one). Note: an expired *refresh* token still requires a browser re-login (`npm start -- setup`) — failover only keeps the agent alive on the fallback provider meanwhile. Prior: Provider circuit breaker + auth failover — during an upstream incident the agent stayed pinned to the primary provider: `ProviderRegistry` re-walked the priority ladder on every call (3 SDK retries × 2-min timeout, then the agent's own 5-retry loop restarting from priority 0), so every message was slow for hours. New `src/llm/circuit-breaker.ts` (`ProviderCircuitBreaker`) demotes a provider for `llm.circuitBreaker.cooldownMs` (default 5 min) after `failureThreshold` (default 2) failover-eligible failures; `getCandidates()` filters through it, `chat`/`chatStream` record success/failure. Health is keyed by a new `ProviderEntry.providerName` (config provider name, not the registration label) so default + background slot entries sharing an upstream are demoted together. Filter never returns an empty list — with everything open, the full ladder is used. Only failover-eligible errors count (the `isFailoverCandidate()` result gates both failover and demotion). `isFailoverCandidate()` now returns `true` for `authentication_error`/`invalid_api_key` — credentials are per-provider, so a rejected key on the primary says nothing about the fallback (a bare untyped `401` still doesn't fail over). No config edit on upgrade: `llm.circuitBreaker` is nested, and the Zod schema defaults it. Design + as-built notes: `docs/superpowers/specs/2026-07-31-provider-circuit-breaker-design.md`. Prior: New Claude models + CLI version bump (#229) — added Sonnet 5 (`claude-sonnet-5`, intro pricing $2/$10 MTok until 2026-08-31, newer + cheaper than sonnet-4-6), Opus 4.8, Opus 4.7, and Fable 5 to the `claude-agent` alias map (`opus`→`claude-opus-4-8`, `sonnet`→`claude-sonnet-5`, `fable`→`claude-fable-5`); default slot template + `config.ts` fallback → `claude-sonnet-5`. New `modelRejectsSamplingParams()` omits `temperature`/`top_p`/`top_k` for models that reject them with 400 (Opus 4.7/4.8, Sonnet 5, Fable, Mythos) in both chat + stream paths — without this the new models fail on the `anthropic` provider. Impersonated user-agent bumped to `claude-cli/2.1.195` in anthropic + openai-compatible providers (was 2.1.104 / 2.1.81). Note: extended-thinking `budget_tokens` shape is also rejected by these models (need adaptive thinking) — not yet migrated. Prior: Cron delivery hardening (#224-226) — root cause of the 2026-06-30 "no reminders" outage: a second half-dead gateway instance claimed cron jobs from the shared SQLite table and published them into a bus nobody consumed. Fixes: lane watchdog (`agent.laneTimeoutMs`, default 10 min — hung run aborted + concurrency slot released, lanes can't wedge silently), system-lane queue telemetry (depth logging + warn when messages pile up with no waiting consumer) with bus errors routed to the file logger, HEARTBEAT.md re-sync without restart (`heartbeat.resyncIntervalMs` mtime polling; removed sections disable their cron jobs), cron/heartbeat memory scope (DM-delivered runs flush to `users/{id}/memory/` via `findUserByDmChatId` structural detection, groups stay per-chat), gateway instance lock (`.janus/gateway.pid` — stale lock taken over, live holder waited ~30s then startup refused) + shutdown force-exit backstop (15s). Prior: Phase 15 — Context management redesign (single pre-call router replacing Phase 1/2/3 + emergency cascade; transcript rotation in SessionManager so sessions stay bounded; unified tool result cap eliminates the 100x disk-vs-memory mismatch; dynamic content moved to separate uncached system block so history doesn't accumulate N copies of pinned/profile per turn; flush decoupled from compaction; compaction timeout 90s → 15min + force-drop fallback). Replaces the 7-mechanism / 12-threshold system that accumulated 20+ patch PRs since 2026-04-01. Prior: cron chat_id structural default from current conversation context, stale time anchor relabel in summarization (so the frozen `[Conversation summarized at: ...]` is no longer mistaken for "now"), cron `runs` response wrapped with `_note` explainer for ambiguous `durationMs` / `status:ok` (PR #216). Prior: Phase 14 — Token optimization (static/dynamic system prompt split for Anthropic cache, memory flush consolidated 5→3 triggers, summarization quality retry removed, background context mode for cron/heartbeat, `--token-debug` CLI flag, heartbeat chat field routing, Anthropic SDK 0.90.0, diet-tracker skill, version 0.14.0). Prior: Phase 13 — Distribution overhaul (install scripts Unix/Windows, tarball update mode, backup/restore/doctor, inbound image vision, surrogate sanitization, releases v1.0.0). Prior: Phase 12 — Cron targets overhaul (owner+targets model replacing target_user_id, CronTarget[] with per-target status tracking pending/confirmed/rejected, multi-target context injection per-target max 3 pending 5 msgs each, auto-disable on full response, target self-reject on remove, owner-only update + privacy filtering in list/status, recursion guard removed, stale nextRunAt recompute on startup, startup migration for legacy target_user_id jobs, auto-cleanup of old disabled jobs via configurable `cron.cleanup`, update command detects new config sections via janus.example.json diff, SQLite migrations 12-13). Prior: Security hardening sprint (IPv6 SSRF guard for fc00::/7+fe80::/10+ff00::/8, untrusted content tags on web_search results, strict ownerIds in multi-user, secret redaction in tool results for KEY=/Bearer/sk-/ghp_/AKIA/JWT, token masking in logger, exec master switch via `tools.execEnabled`, credential encryption AES-256-GCM for auth.json, gate audit log in SQLite migration 11). Prior: Multi-agent routing (AgentResolver with generic match bag routing and first-match-wins bindings, config `agents[]`/`bindings[]`/`defaultAgentId`, per-agent EGO.md/AGENTS.md/HEARTBEAT.md path overrides, per-agent tool allow/deny + params + model slot overrides, agent-prefixed session keys `{agentId}:{channel}:{chatId}` with legacy auto-migration, per-agent memory isolation via `resolveMemDir` when `memory.shared: false`, per-agent cron jobs with `agentId` on cron_jobs table (migration 10), per-agent HEARTBEAT.md loading + sync to CronService, `ensureAgentDir()` auto-creates `.janus/agents/{id}/memory/`, agent name in identity + `Agent:` line in session context, zero-config backward compat with implicit "main" agent). Prior: Cross-user cron reminders (replaced by cron targets overhaul). Prior: Agent hardening (cross-tool loop detection with 6-call pattern window + MAX_ITERATIONS=200 safety limit, proactive context overflow detection at 90%/95% token budget with pruning + emergency compression, `pruneOldToolResults` trims results older than 8 messages to 200 chars, prompt injection guard wraps web_fetch/Jina output in `<untrusted_content>` XML tags, proactive OAuth token refresh every 30 min for tokens expiring within 1 hour). Prior: Multimodal tool results (ToolContentBlock[] for images in tool responses, Anthropic native vision passthrough, OpenAI/Codex text fallback, `__MULTIMODAL__` prefix protocol, `toolResultWithImage()` helper). Prior: MCP schema normalization for OpenAI (strip unsupported JSON Schema keywords), anti-Cloudflare retry in web_fetch (UA rotation, browser-like headers, escalation to browser tool). Prior: Quick wins batch (sender name in session context for family chat identity, incremental JSONL append with post-compaction truncation, subagent partial progress on timeout, cron `finished_at` tracking with migration 9, exec env injection deny patterns for JVM/Python/.NET/LD_PRELOAD/NODE_OPTIONS). Prior: Browser Operator Playwright migration (replaced Chrome Extension + WS server with Playwright persistent context, `_snapshotForAI()` AI-native snapshots, `aria-ref` locators, ~200 lines replaces ~2000 lines). Prior: Browser lifecycle fix (setContext preserves runtime across messages, EADDRINUSE recovery with retry, WS server port conflict handling), silent summarization (⏳ indicator instead of verbose Polish notifications). Prior: Multi-user privacy (per-user cron jobs with userId ownership in migration 6, file access control in family chats via validatePath, chat directories `.janus/chats/{chatId}/`, DB hardening with sqlite3 exec deny patterns, per-user context isolation in system prompt). Prior: Voice transcription (Groq Whisper auto-transcribe for Telegram voice/audio messages, configurable language/duration, `voice` config section), GitHub skill (`gh` CLI wrapper — repos, issues, PRs, CI, releases, gists, search). Prior: Memory flush v2 (pointer-based lastFlushed tracking, context-aware extraction with session summary + MEMORY.md, triple output HISTORY.md/daily notes/MEMORY.md, 5 triggers: count/token/pre-summarization/idle/shutdown, memoryIdleFlushMs config), graceful shutdown flush (SIGTERM/SIGINT flush sessions before abort, memoryFlushInterval 10→5), leaked control token stripping (sanitize `<|endoftext|>`, `[INST]`, etc.), Telegram forum/topic session isolation (per-topic sessions in forum supergroups), group mention policy (`telegram.groupPolicy: all|mention`), cron missed job staggering (30s apart on restart), browser tool (Playwright headless Chromium, optional dep, 3rd escalation tier: search→fetch→browser). Prior: LLM overload resilience (5-retry exponential backoff 1s→16s, user notification, abort-aware sleep, clean error after exhaustion), SDK timeout hardening (2 min per request vs default 10 min, 90s hard cap on background flush/summarization calls), multi-provider OAuth (shared FileTokenStore, `providers[]` with auth/priority/purpose), dynamic model listing from APIs (Anthropic `/v1/models` + OpenAI `/v1/models` with filtering), setup wizard with fallback provider selection, Windows compatibility (`path.sep` in validatePath, conditional test skipping), diagnostic timing logs (Telegram→lane→context→LLM→flush→summarization), multi-lane concurrent message queue (semaphore-based, user:3/cron:1/heartbeat:1, AbortSignal), skill-creator meta-skill (mtime-based cache invalidation), non-blocking embedder (setImmediate yield points, delayed startup reindex). Prior: per-user overrides, community skills, PROFILE.md auto-update, invite links, Telegram hardening, orphaned tool_use repair, `/stop` command, `self_update` tool, auto-update cron, native OAuth (PKCE), security hardening, reliability, tools (web_fetch, web_search, append_file, heartbeat, self_update, invite), MCP client, steering messages, extended thinking, SubagentRegistry with cancel, prompt caching, 5xx failover, cross-platform shell, cron/heartbeat in CLI mode, web_fetch hardening, web search cache. Prior: multi-user, subscription providers, setup wizard, MCP server, vector search, temporal decay, memory flush, lazy skills, token management, cron scheduler, streaming, gates, hybrid memory search (FTS5), SQLite storage, tests (374), CI pipeline.

## Architecture

```
CLI/Telegram → MessageBus → AgentLoop → ProviderRegistry → Tools → Response
                                ↑              ↑               ↑
                          CronService        Database    spawn_agent → SubAgent
                          HeartbeatService (SQLite+FTS5)  Learner (metrics)
                                                         Browser Operator → Playwright → Real Browser
```

### Key modules (src/)
- `bootstrap.ts` — Shared `createApp()` init (used by both CLI and gateway)
- `agent/` — Agent loop (LLM iteration with tool calls, `stop()` for mid-task cancellation, MAX_ITERATIONS=200 hard safety limit, cross-tool loop detection with 6-call pattern window, **pre-call router** delegated to `context/context-manager.ts` (replaces former Phase 1/2/3 + emergency compression), multi-target context injection (per-target status, max 3 pending, 5 msgs each)), subagent spawning (partial progress on timeout), SubagentRegistry (cancel/cancelAll), AgentResolver (generic match bag routing with first-match-wins bindings, per-agent config: tools, params, model slots, bootstrap file overrides)
- `auth/` — Native OAuth (PKCE S256, token storage, auto-refresh, proactive refresh every 30 min for tokens expiring within 1 hour) for Anthropic + Codex, API key storage (`saveApiKey`/`loadApiKey`), unified credential file (`.janus/auth.json`), credential encryption (AES-256-GCM at rest)
- `bus/` — MessageBus + AsyncQueue (bounded, backpressure), multi-lane concurrent queue (semaphore, per-lane concurrency config, AbortSignal), steering messages (mid-run injection)
- `channels/` — CLI (interactive REPL, persistent history, `/stop` + `/help` + `/model` + `/config`), Telegram (grammy, typing indicators, start retry, `/stop` + `/whoami` + `/model`, invite deep-link onboarding, forum/topic session isolation, group mention policy, voice transcription)
- `commands/` — onboard (alias: init), gateway, mcp-server, setup (interactive wizard), update (pull + install + test + new config section detection via janus.example.json diff)
- `config/` — JSON config + Zod schema, `janus.json` (workspace) + `~/.janus/config.json` (user) + env. Providers+slots architecture with `resolveLLM()` normalization. Credentials in `.janus/auth.json`. Multi-agent: `agents[]` (AgentDefinitionSchema), `bindings[]` (BindingSchema), `defaultAgentId`
- `context/` — System prompt builder (identity + tool guidelines + EGO + project + skills + memory + learner), explicit cache boundary marker (`<!-- JANUS_CACHE_BOUNDARY -->`) between static and dynamic content. `context-manager.ts` (single module): pre-call router (4 routes: fits/truncate_only/compact_only/compact_then_truncate), soft/hard trim transforms, budget resolution from contextWindow. Replaces former `context-budget.ts` (Phase 1/2/3 + emergency).
- `db/` — SQLite database (better-sqlite3, WAL mode, 13 numbered migrations)
- `gates/` — Pattern-based gate system (exec + file writes + spawn_agent + self_update:update + obfuscation detection + Unicode invisible char stripping + URL-safe obfuscation check + env injection deny patterns for JVM/Python/.NET/LD_PRELOAD/NODE_OPTIONS), CLI + Telegram gates, gate audit log (SQLite, migration 11)
- `learner/` — Execution metrics (SQLite or JSONL fallback), keyword similarity, recommendations (wired into context prompt)
- `llm/` — Anthropic native + OpenAI-compatible + ClaudeAgent + Codex + Codex OAuth providers, ProviderRegistry (multi-provider with failover + 5xx + RESOURCE_EXHAUSTED + rate-limit hardening + 422 classification + typed auth errors), ProviderCircuitBreaker (`circuit-breaker.ts` — per-provider failure threshold + cooldown keyed by `ProviderEntry.providerName`, never returns an empty candidate list, config `llm.circuitBreaker`), streaming, extended thinking, prompt caching, SDK utils (structured output), model listing from APIs, SDK timeout (2 min), toolChoice with fallback, multimodal tool results (ToolContentBlock[] with image support for Anthropic, text fallback for OpenAI/Codex)
- `mcp/` — MCP server (JSON-RPC, stdio, tool bridge) + MCP client (connect to external servers, auto-discover tools, schema normalization for OpenAI compatibility)
- `memory/` — MEMORY.md + HISTORY.md + daily notes + MemoryIndex (FTS5 + vector hybrid search with temporal decay), embedder (local @xenova/transformers, setImmediate yield points for non-blocking inference), MemoryStore with `resolveMemDir` (per-agent memory isolation when `memory.shared: false`)
- `services/` — CronService (persistent cron scheduler, SQLite, missed job staggering on restart, per-user job ownership via userId, custom session IDs, per-agent agentId on cron_jobs, job ID in execution context for agent self-removal, multi-target delivery (CronTarget[] with per-target status tracking), auto-disable on full response, auto-cleanup of old disabled jobs (configurable via cron.cleanup), stale nextRunAt recompute), HeartbeatService (HEARTBEAT.md → CronService sync, per-user HEARTBEAT.md with userId routing, per-agent HEARTBEAT.md loading with agentId sync), Browser Operator (Playwright persistent context, AI-native snapshots, policy enforcement)
- `session/` — JSONL persistence with **transcript rotation on compaction** (`{key}.{ts}.jsonl` archive + new file with compaction entry + tail), bounded session size on disk (~keepRecentTokens). Unified tool result cap (50% of effective budget × 2.5 chars/token), same value in-loop and on-disk so reload size matches live size. `forceDropOldest()` fallback for failed compaction. Per-key mutex, agent-prefixed keys (`{agentId}:{channel}:{chatId}`) with legacy auto-migration.
- `skills/` — SKILL.md loader (YAML frontmatter + markdown), lazy loading (stubs + read on demand), mtime-based cache invalidation on skill file writes, pinned skill state (`pinned: [file, ...]` frontmatter — listed files survive summarization, see docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md)
- `invites/` — InviteStore (in-memory, 24h TTL) for Telegram deep-link onboarding
- `tools/` — 15 built-in tools (exec [master switch via `tools.execEnabled`], read/write/edit/append-file, list-dir, message, spawn_agent, cron [targets[] parameter replacing target_user_id, target self-reject on remove, owner-only update, privacy filtering in list/status], web_fetch [prompt injection guard: `<untrusted_content>` XML tags], web_search [prompt injection guard: `<untrusted_content>` XML tags], browser [Playwright persistent context], heartbeat, self_update, invite), path validation (symlink safety, user-scoped access in family chats), secret redaction in tool results (KEY=/Bearer/sk-/ghp_/AKIA/JWT)
- `utils/` — Logger (token masking in output), cross-platform shell config (`getShellConfig`, `killProcessTree`), sanitize (strip leaked LLM control tokens + invisible Unicode), SSRF guard (IPv4 + IPv6 private ranges), timezone-aware date helpers (`localDate`/`localTimestamp` via configured IANA timezone), version utilities (`isNewerVersion`, `getLatestRelease`, `downloadFile` for tarball-based updates)
- `users/` — User resolver (Telegram userId/username → Janus user), per-user profiles, tool/skill filtering, `ensureUserDir()` (auto-create `.janus/users/{id}/` on first resolution, channel-agnostic), `ensureChatDir()` (auto-create `.janus/chats/{chatId}/`)

### Browser Operator
Real-browser automation via Playwright persistent context. Controls a dedicated Chrome profile through AI-native ARIA snapshots with element refs.

**Architecture:** `Agent → browser tool → Playwright persistent context → Real Chrome`

- `src/services/browser/browser-playwright-runtime.ts` — Playwright launcher (persistent context, `_snapshotForAI()`, `aria-ref` locators), lazy start, cookie dismissal
- `src/services/browser/browser-types.ts` — Commands, responses, errors, policy types, runtime state machine
- `src/services/browser/browser-policy.ts` — Safety enforcement (dangerous action text blocking, read-only default)
- `src/tools/builtin/browser-operator.ts` — Single `browser` tool with sub-commands, idle timer, circuit breaker

**Key design decisions:**
- AI-native snapshots via Playwright `_snapshotForAI()` (ARIA tree with `[ref=eN]` markers)
- Actions via `aria-ref` locator engine (`page.locator('aria-ref=e5').click()`)
- Persistent context (`launchPersistentContext`) for cookie/session persistence
- Dedicated Chrome profile (never personal browser)
- Lazy start on first tool call
- Dangerous actions (checkout, payment) blocked by policy

**How it works at runtime:**
1. Agent calls `browser({ command: "snapshot" })` (or any browser command)
2. Janus checks if Playwright context is running → launches if not:
   ```
   chromium.launchPersistentContext('~/.janus/chrome-profile', { headless: false, channel: 'chrome' })
   ```
3. Command executes directly via Playwright API → returns structured result
4. Snapshots return ARIA tree with `[ref=eN]` markers for element identification
5. Actions use `page.locator('aria-ref=eN')` to resolve refs to real elements

**Agent workflow example (shopping):**
```
browser({ command: "navigate", args: { url: "https://allegro.pl" } })
browser({ command: "snapshot" })                    → ARIA tree with [ref=e1], [ref=e2]...
browser({ command: "dismissCookies" })              → structural overlay detection
browser({ command: "click", args: { elementId: "e1" } })   → click via aria-ref
browser({ command: "type", args: { elementId: "e1", text: "lavazza 1kg" } })
browser({ command: "pressKey", args: { key: "Enter" } })
browser({ command: "waitFor", args: { type: "domStable", stableForMs: 1200 } })
browser({ command: "snapshot" })                    → updated ARIA tree with results
```

**Environment variables:**
- `CHROME_PATH` — override Chrome binary path (Playwright auto-detects)

### Bootstrap files (unique to Janus)
- `~/.janus/EGO.md` — Agent character (global, static)
- `~/.janus/config.json` — User-level config (merged under workspace config)
- `~/.janus/auth.json` — Credentials: OAuth tokens + API keys (0o600 permissions, auto-refresh)
- `~/.janus/history` — CLI command history (max 500 entries)
- `~/.janus/.update-complete` — Post-update marker (consumed on startup, triggers Telegram notification)
- `./.janus/users/{id}/PROFILE.md` — Per-user profile (auto-updated by agent when learning preferences)
- `./.janus/users/{id}/AGENTS.md` — Per-user agent behavior override (appended to global AGENTS.md)
- `./.janus/users/{id}/HEARTBEAT.md` — Per-user scheduled tasks (routed to user's Telegram chat)
- `./.janus/chats/{chatId}/` — Per-chat directory (auto-created by `ensureChatDir()`)
- `./.janus/agents/{id}/` — Per-agent directory (auto-created by `ensureAgentDir()`): optional EGO.md, AGENTS.md, HEARTBEAT.md overrides, `memory/` for isolated agent memory
- `./JANUS.md` — Project-specific instructions (per-repo, like CLAUDE.md)
- `./AGENTS.md` — Agent behavior rules (per-workspace, customizable — all behavioral instructions live here, not in code)
- `./HEARTBEAT.md` — Autonomous periodic tasks (per-workspace, supports `every Xm/h/d`, `at HH:MM`, and cron expressions)
- `~/.janus/chrome-profile/` — Dedicated Chrome profile for Browser Operator (persistent cookies, isolated from personal browsing)

## Commands

```bash
npm start                    # Interactive CLI
npm start -- -m "message"   # Single message
npm start -- gateway        # Headless (Telegram)
npm start -- onboard        # Init workspace + per-user dirs
npm start -- update          # Pull + install + test + user dirs
npm start -- mcp-server     # MCP server (stdin/stdout JSON-RPC)
```

## Config

`janus.json` (workspace) + `~/.janus/config.json` (user) + env vars (`JANUS_MODEL`, `JANUS_API_BASE`). Credentials in `.janus/auth.json` (separated from config). Setup wizard on first run if no provider configured. `/config` command to reconfigure.

Three auth modes (mutually exclusive):
- **API Key** — openrouter, anthropic, openai, deepseek, groq (pay per token)
- **Subscription** — `claude-agent` (Claude Code Max via `claude login`), `codex` (ChatGPT Plus/Pro via `codex login`)
- **OAuth** — `anthropic` or `codex` with native PKCE flow (browser-based login, auto-refresh)

### Config format: providers + slots

```json
{
  "llm": {
    "providers": {
      "anthropic": { "auth": "oauth", "priority": 0 },
      "openrouter": { "priority": 1 }
    },
    "slots": {
      "default": { "anthropic": "claude-sonnet-5", "openrouter": "anthropic/claude-sonnet-5" },
      "background": { "anthropic": "claude-haiku-4-5-20251001" }
    }
  }
}
```

- **`providers`** — object keyed by provider name. Fields: `auth` (api_key/oauth/cli), `priority` (0=primary, higher=fallback), `apiBase` (optional).
- **`slots`** — model routing. `default` = main chat. `background` = cron/heartbeat/summarization. `null` = use default slot. Each slot maps provider name → model ID.
- **Credentials** — stored in `.janus/auth.json` (not in config). Both API keys (`{ type: "api_key", key: "..." }`) and OAuth tokens.
- **Normalization** — legacy flat config (`llm.provider`, `llm.model`) auto-converted to providers+slots at load time (backward compatible).

Key sections: `llm` (providers, slots, thinking, reasoningEffort, toolTemperature), `agent` (iterations, tokenBudget=750K, contextWindow=1M, temperature=0.3, skillLimits, onLLMError, lanes), `agents` (AgentDefinitionSchema[]: id, name, ego/agents/heartbeat path overrides, tools allow/deny, params, slots), `bindings` (BindingSchema[]: agentId, match bag with channel/chatId/topicId/userId), `defaultAgentId`, `workspace`, `tools` (execEnabled, exec deny patterns, execDenyPatternsExtra), `database`, `heartbeat`, `telegram` (token, allowlist, denyByDefault, groupPolicy), `streaming`, `gates`, `memory` (vectorSearch, vectorWeight, textWeight, recentDays, shared), `voice` (Groq Whisper), `autoUpdate` (enabled, schedule), `cron` (cleanup: enabled, intervalDays, time, maxAgeDaysOneShot, maxAgeDaysRecurring), `users` (profiles, tool/skill allow/deny), `ownerIds` (owner-only tool access), `family` (groupChatIds, shared scope), `mcp` (servers), `timezone` (IANA timezone string, auto-detected from system if omitted). Config hot reload via `watchConfig()` (fs.watch on janus.json + .janus/config.json).

## Dependencies

12 runtime: @anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk, @openai/codex-sdk, @xenova/transformers, better-sqlite3, chalk, commander, croner, grammy, openai, yaml, zod
1 optional: playwright (for browser operator — real Chrome via Playwright persistent context)
4 dev: @types/better-sqlite3, tsx, typescript, vitest

## Testing

```bash
npm test           # Run all tests (vitest)
npm run typecheck   # TypeScript type checking
```

783 tests across 72 test files: unit (agent-resolver, anthropic-oauth, async-queue, browser-tool, circuit-breaker, codex-oauth, config-schema, context-builder, cron-service, cron-tool, error-classification, exec-tool, gate-routing, heartbeat-parser, heartbeat-resync, instance-lock, invite, lane-watchdog, learner, mcp-server, memory-index, pattern-gate, pkce, provider-registry, sanitize, sdk-utils, self-update-tool, session-lock, setup, shell, skill-loading, stop-command, streaming, system-message, telegram-channel, token-counting, token-store, tool-registry, user-resolver, validate-path, vector-search, version-utils, voice-transcribe, web-tools) + integration (agent-loop with mock LLM). CI runs on push/PR via GitHub Actions.

## Conventions

See **[CODING.md](CODING.md)** for full coding standards (naming, imports, types, errors, testing, module structure).

Summary:
- TypeScript, ESM (`"type": "module"`)
- Code and comments in English
- No references to other projects in code
- Follow patterns established in existing code — see CODING.md before writing new code
