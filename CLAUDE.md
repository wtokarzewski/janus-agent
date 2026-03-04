# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

Janus is a universal AI agent. CLI + Telegram, ~7,500 lines TypeScript.

**Name:** Janus — Roman god of beginnings, transitions, and duality. Two faces looking to the past and the future. Reflects the agent's dual nature: planning vs execution, analysis vs implementation, AI vs human control.

**Status:** Post-Phase 7 — native OAuth (PKCE for Anthropic + Codex), security hardening (path validation, process tree kill, session locking, obfuscation detection), reliability (tool call guidelines, error hints, reflection prompt, duplicate prevention), new tools (web_fetch, web_search, append_file, heartbeat), MCP client, steering messages, extended thinking, SubagentRegistry with cancel, prompt caching, 5xx failover, skill self-creation (prompt-driven). Prior: multi-user (scoped memory, per-user filtering, family groups), subscription providers (Claude Agent SDK, Codex SDK), setup wizard, MCP server, vector search (local embeddings), temporal decay, memory flush, lazy skills, token management, cron scheduler, streaming, gates, hybrid memory search (FTS5), SQLite storage, tests (248), CI pipeline.

## Architecture

```
CLI/Telegram → MessageBus → AgentLoop → ProviderRegistry → Tools → Response
                                ↑              ↑               ↑
                          CronService        Database    spawn_agent → SubAgent
                          HeartbeatService (SQLite+FTS5)  Learner (metrics)
```

### Key modules (src/)
- `bootstrap.ts` — Shared `createApp()` init (used by both CLI and gateway)
- `agent/` — Agent loop (LLM iteration with tool calls), subagent spawning, SubagentRegistry (cancel/cancelAll)
- `auth/` — Native OAuth (PKCE S256, token storage, auto-refresh) for Anthropic + Codex
- `bus/` — MessageBus + AsyncQueue (bounded, backpressure), steering messages (mid-run injection)
- `channels/` — CLI (interactive REPL, persistent history), Telegram (grammy, typing indicators, start retry)
- `commands/` — onboard (alias: init), gateway, mcp-server, setup (interactive wizard)
- `config/` — JSON config + Zod schema, `~/.janus/config.json` (user) + `janus.json` (workspace) + env
- `context/` — System prompt builder (identity + tool guidelines + EGO + project + skills + memory + learner)
- `db/` — SQLite database (better-sqlite3, WAL mode, 5 numbered migrations)
- `gates/` — Pattern-based gate system (exec + file writes + spawn_agent + obfuscation detection), CLI + Telegram gates
- `learner/` — Execution metrics (SQLite or JSONL fallback), keyword similarity, recommendations (wired into context prompt)
- `llm/` — Anthropic native + OpenAI-compatible + ClaudeAgent + Codex + Codex OAuth providers, ProviderRegistry (multi-provider with failover + 5xx), streaming, extended thinking, prompt caching, SDK utils (structured output)
- `mcp/` — MCP server (JSON-RPC, stdio, tool bridge) + MCP client (connect to external servers, auto-discover tools)
- `memory/` — MEMORY.md + HISTORY.md + daily notes + MemoryIndex (FTS5 + vector hybrid search with temporal decay), embedder (local @xenova/transformers)
- `services/` — CronService (persistent cron scheduler, SQLite, recursion guard), HeartbeatService (HEARTBEAT.md → CronService sync)
- `session/` — JSONL persistence, atomic writes, summarization, per-key mutex locking
- `skills/` — SKILL.md loader (YAML frontmatter + markdown), lazy loading (stubs + read on demand)
- `tools/` — 12 built-in tools (exec, read/write/edit/append-file, list-dir, message, spawn_agent, cron, web_fetch, web_search, heartbeat), path validation (symlink safety)
- `users/` — User resolver (Telegram userId/username → Janus user), per-user profiles, tool/skill filtering

### Bootstrap files (unique to Janus)
- `~/.janus/EGO.md` — Agent character (global, static)
- `~/.janus/config.json` — User-level config (merged under workspace config)
- `~/.janus/auth.json` — OAuth tokens (0o600 permissions, auto-refresh)
- `~/.janus/history` — CLI command history (max 500 entries)
- `~/.janus/users/{id}/PROFILE.md` — Per-user profile
- `./JANUS.md` — Project-specific instructions (per-repo, like CLAUDE.md)
- `./AGENTS.md` — Agent behavior rules (per-workspace, customizable)
- `./HEARTBEAT.md` — Autonomous periodic tasks (per-workspace, supports `every Xm/h/d`, `at HH:MM`, and cron expressions)

## Commands

```bash
npm start                    # Interactive CLI
npm start -- -m "message"   # Single message
npm start -- gateway        # Headless (Telegram)
npm start -- onboard        # Init workspace
npm start -- mcp-server     # MCP server (stdin/stdout JSON-RPC)
```

## Config

`~/.janus/config.json` (user) + `janus.json` (workspace) + env vars (`JANUS_MODEL`, `JANUS_API_BASE`). Provider auto-detected from API key. Setup wizard on first run if no provider configured. `/config` command to reconfigure.

Three auth modes (mutually exclusive):
- **API Key** — openrouter, anthropic, openai, deepseek, groq (pay per token)
- **Subscription** — `claude-agent` (Claude Code Max via `claude login`), `codex` (ChatGPT Plus/Pro via `codex login`)
- **OAuth** — `anthropic` or `codex` with native PKCE flow (browser-based login, auto-refresh)

Key sections: `llm` (provider, model, multi-provider, thinking, reasoningEffort, toolTemperature), `agent` (iterations, tokenBudget, contextWindow, skillLimits, memoryFlushInterval, onLLMError), `workspace`, `tools` (exec deny patterns, execDenyPatternsExtra), `database`, `heartbeat`, `telegram`, `streaming`, `gates`, `memory` (vectorSearch, vectorWeight, textWeight, recentDays), `users` (profiles, tool/skill allow/deny), `family` (groupChatIds, shared scope), `mcp` (servers).

## Dependencies

12 runtime: @anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk, @openai/codex-sdk, @xenova/transformers, better-sqlite3, chalk, commander, croner, grammy, openai, yaml, zod
4 dev: @types/better-sqlite3, tsx, typescript, vitest

## Testing

```bash
npm test           # Run all tests (vitest)
npm run typecheck   # TypeScript type checking
```

248 tests across 29 test files: unit (anthropic-oauth, async-queue, codex-oauth, config-schema, context-builder, cron-service, cron-tool, exec-tool, gate-routing, heartbeat-parser, learner, mcp-server, memory-index, pattern-gate, pkce, provider-registry, sdk-utils, session-lock, setup, skill-loading, streaming, system-message, token-counting, token-store, tool-registry, user-resolver, validate-path, vector-search) + integration (agent-loop with mock LLM). CI runs on push/PR via GitHub Actions.

## Conventions

- TypeScript, ESM (`"type": "module"`)
- Code and comments in English
- No references to other projects in code
