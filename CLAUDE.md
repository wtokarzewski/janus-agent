# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

Janus is a universal AI agent. CLI + Telegram + Browser Operator, ~13,300 lines TypeScript.

**Name:** Janus — Roman god of beginnings, transitions, and duality. Two faces looking to the past and the future. Reflects the agent's dual nature: planning vs execution, analysis vs implementation, AI vs human control.

**Status:** Phase 10 — Multimodal tool results (ToolContentBlock[] for images in tool responses, Anthropic native vision passthrough, OpenAI/Codex text fallback, `__MULTIMODAL__` prefix protocol, `toolResultWithImage()` helper). Prior: MCP schema normalization for OpenAI (strip unsupported JSON Schema keywords), anti-Cloudflare retry in web_fetch (UA rotation, browser-like headers, escalation to browser tool). Prior: Quick wins batch (sender name in session context for family chat identity, incremental JSONL append with post-compaction truncation, subagent partial progress on timeout, cron `finished_at` tracking with migration 9, exec env injection deny patterns for JVM/Python/.NET/LD_PRELOAD/NODE_OPTIONS). Prior: Browser Operator Playwright migration (replaced Chrome Extension + WS server with Playwright persistent context, `_snapshotForAI()` AI-native snapshots, `aria-ref` locators, ~200 lines replaces ~2000 lines). Prior: Browser lifecycle fix (setContext preserves runtime across messages, EADDRINUSE recovery with retry, WS server port conflict handling), silent summarization (⏳ indicator instead of verbose Polish notifications). Prior: Multi-user privacy (per-user cron jobs with userId ownership in migration 6, file access control in family chats via validatePath, chat directories `.janus/chats/{chatId}/`, DB hardening with sqlite3 exec deny patterns, per-user context isolation in system prompt). Prior: Voice transcription (Groq Whisper auto-transcribe for Telegram voice/audio messages, configurable language/duration, `voice` config section), GitHub skill (`gh` CLI wrapper — repos, issues, PRs, CI, releases, gists, search). Prior: Memory flush v2 (pointer-based lastFlushed tracking, context-aware extraction with session summary + MEMORY.md, triple output HISTORY.md/daily notes/MEMORY.md, 5 triggers: count/token/pre-summarization/idle/shutdown, memoryIdleFlushMs config), graceful shutdown flush (SIGTERM/SIGINT flush sessions before abort, memoryFlushInterval 10→5), leaked control token stripping (sanitize `<|endoftext|>`, `[INST]`, etc.), Telegram forum/topic session isolation (per-topic sessions in forum supergroups), group mention policy (`telegram.groupPolicy: all|mention`), cron missed job staggering (30s apart on restart), browser tool (Playwright headless Chromium, optional dep, 3rd escalation tier: search→fetch→browser). Prior: LLM overload resilience (5-retry exponential backoff 1s→16s, user notification, abort-aware sleep, clean error after exhaustion), SDK timeout hardening (2 min per request vs default 10 min, 90s hard cap on background flush/summarization calls), multi-provider OAuth (shared FileTokenStore, `providers[]` with auth/priority/purpose), dynamic model listing from APIs (Anthropic `/v1/models` + OpenAI `/v1/models` with filtering), setup wizard with fallback provider selection, Windows compatibility (`path.sep` in validatePath, conditional test skipping), diagnostic timing logs (Telegram→lane→context→LLM→flush→summarization), multi-lane concurrent message queue (semaphore-based, user:3/cron:1/heartbeat:1, AbortSignal), skill-creator meta-skill (mtime-based cache invalidation), non-blocking embedder (setImmediate yield points, delayed startup reindex). Prior: per-user overrides, community skills, PROFILE.md auto-update, invite links, Telegram hardening, orphaned tool_use repair, `/stop` command, `self_update` tool, auto-update cron, native OAuth (PKCE), security hardening, reliability, tools (web_fetch, web_search, append_file, heartbeat, self_update, invite), MCP client, steering messages, extended thinking, SubagentRegistry with cancel, prompt caching, 5xx failover, cross-platform shell, cron/heartbeat in CLI mode, web_fetch hardening, web search cache. Prior: multi-user, subscription providers, setup wizard, MCP server, vector search, temporal decay, memory flush, lazy skills, token management, cron scheduler, streaming, gates, hybrid memory search (FTS5), SQLite storage, tests (374), CI pipeline.

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
- `agent/` — Agent loop (LLM iteration with tool calls, `stop()` for mid-task cancellation), subagent spawning (partial progress on timeout), SubagentRegistry (cancel/cancelAll)
- `auth/` — Native OAuth (PKCE S256, token storage, auto-refresh) for Anthropic + Codex, API key storage (`saveApiKey`/`loadApiKey`), unified credential file (`.janus/auth.json`)
- `bus/` — MessageBus + AsyncQueue (bounded, backpressure), multi-lane concurrent queue (semaphore, per-lane concurrency config, AbortSignal), steering messages (mid-run injection)
- `channels/` — CLI (interactive REPL, persistent history, `/stop` + `/help` + `/model` + `/config`), Telegram (grammy, typing indicators, start retry, `/stop` + `/whoami` + `/model`, invite deep-link onboarding, forum/topic session isolation, group mention policy, voice transcription)
- `commands/` — onboard (alias: init), gateway, mcp-server, setup (interactive wizard), update (pull + install + test)
- `config/` — JSON config + Zod schema, `janus.json` (workspace) + `~/.janus/config.json` (user) + env. Providers+slots architecture with `resolveLLM()` normalization. Credentials in `.janus/auth.json`
- `context/` — System prompt builder (identity + tool guidelines + EGO + project + skills + memory + learner), sender name in session context for family chat identity
- `db/` — SQLite database (better-sqlite3, WAL mode, 9 numbered migrations)
- `gates/` — Pattern-based gate system (exec + file writes + spawn_agent + self_update:update + obfuscation detection + Unicode invisible char stripping + URL-safe obfuscation check + env injection deny patterns for JVM/Python/.NET/LD_PRELOAD/NODE_OPTIONS), CLI + Telegram gates
- `learner/` — Execution metrics (SQLite or JSONL fallback), keyword similarity, recommendations (wired into context prompt)
- `llm/` — Anthropic native + OpenAI-compatible + ClaudeAgent + Codex + Codex OAuth providers, ProviderRegistry (multi-provider with failover + 5xx + RESOURCE_EXHAUSTED + rate-limit hardening + 422 classification), streaming, extended thinking, prompt caching, SDK utils (structured output), model listing from APIs, SDK timeout (2 min), toolChoice with fallback, multimodal tool results (ToolContentBlock[] with image support for Anthropic, text fallback for OpenAI/Codex)
- `mcp/` — MCP server (JSON-RPC, stdio, tool bridge) + MCP client (connect to external servers, auto-discover tools, schema normalization for OpenAI compatibility)
- `memory/` — MEMORY.md + HISTORY.md + daily notes + MemoryIndex (FTS5 + vector hybrid search with temporal decay), embedder (local @xenova/transformers, setImmediate yield points for non-blocking inference)
- `services/` — CronService (persistent cron scheduler, SQLite, recursion guard, missed job staggering on restart, per-user job ownership via userId, custom session IDs), HeartbeatService (HEARTBEAT.md → CronService sync, per-user HEARTBEAT.md with userId routing), Browser Operator (Playwright persistent context, AI-native snapshots, policy enforcement)
- `session/` — JSONL persistence (incremental append + post-compaction truncation), atomic writes, summarization, per-key mutex locking
- `skills/` — SKILL.md loader (YAML frontmatter + markdown), lazy loading (stubs + read on demand), mtime-based cache invalidation on skill file writes
- `invites/` — InviteStore (in-memory, 24h TTL) for Telegram deep-link onboarding
- `tools/` — 15 built-in tools (exec, read/write/edit/append-file, list-dir, message, spawn_agent, cron, web_fetch, web_search, browser [Playwright persistent context], heartbeat, self_update, invite), path validation (symlink safety, user-scoped access in family chats)
- `utils/` — Logger, cross-platform shell config (`getShellConfig`, `killProcessTree`), sanitize (strip leaked LLM control tokens + invisible Unicode), SSRF guard
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
      "default": { "anthropic": "claude-sonnet-4-6", "openrouter": "anthropic/claude-sonnet-4-6" },
      "background": { "anthropic": "claude-haiku-4-5-20251001" }
    }
  }
}
```

- **`providers`** — object keyed by provider name. Fields: `auth` (api_key/oauth/cli), `priority` (0=primary, higher=fallback), `apiBase` (optional).
- **`slots`** — model routing. `default` = main chat. `background` = cron/heartbeat/summarization. `null` = use default slot. Each slot maps provider name → model ID.
- **Credentials** — stored in `.janus/auth.json` (not in config). Both API keys (`{ type: "api_key", key: "..." }`) and OAuth tokens.
- **Normalization** — legacy flat config (`llm.provider`, `llm.model`) auto-converted to providers+slots at load time (backward compatible).

Key sections: `llm` (providers, slots, thinking, reasoningEffort, toolTemperature), `agent` (iterations, tokenBudget=750K, contextWindow=1M, temperature=0.3, skillLimits, memoryFlushInterval, memoryIdleFlushMs, onLLMError, lanes), `workspace`, `tools` (exec deny patterns, execDenyPatternsExtra), `database`, `heartbeat`, `telegram` (token, allowlist, denyByDefault, groupPolicy), `streaming`, `gates`, `memory` (vectorSearch, vectorWeight, textWeight, recentDays), `voice` (Groq Whisper), `autoUpdate` (enabled, schedule), `users` (profiles, tool/skill allow/deny), `ownerIds` (owner-only tool access), `family` (groupChatIds, shared scope), `mcp` (servers). Config hot reload via `watchConfig()` (fs.watch on janus.json + .janus/config.json).

## Dependencies

12 runtime: @anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk, @openai/codex-sdk, @xenova/transformers, better-sqlite3, chalk, commander, croner, grammy, openai, yaml, zod
1 optional: playwright (for browser operator — real Chrome via Playwright persistent context)
4 dev: @types/better-sqlite3, tsx, typescript, vitest

## Testing

```bash
npm test           # Run all tests (vitest)
npm run typecheck   # TypeScript type checking
```

400 tests across 39 test files: unit (anthropic-oauth, async-queue, browser-tool, codex-oauth, config-schema, context-builder, cron-service, cron-tool, exec-tool, gate-routing, heartbeat-parser, invite, learner, mcp-server, memory-index, pattern-gate, pkce, provider-registry, sanitize, sdk-utils, self-update-tool, session-lock, setup, shell, skill-loading, stop-command, streaming, system-message, telegram-channel, token-counting, token-store, tool-registry, user-resolver, validate-path, vector-search, voice-transcribe, web-tools) + integration (agent-loop with mock LLM). CI runs on push/PR via GitHub Actions.

## Conventions

See **[CODING.md](CODING.md)** for full coding standards (naming, imports, types, errors, testing, module structure).

Summary:
- TypeScript, ESM (`"type": "module"`)
- Code and comments in English
- No references to other projects in code
- Follow patterns established in existing code — see CODING.md before writing new code
