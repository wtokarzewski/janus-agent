# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

Janus is a universal AI agent. CLI + Telegram, ~6,500 lines TypeScript.

**Name:** Janus — Roman god of beginnings, transitions, and duality. Two faces looking to the past and the future. Reflects the agent's dual nature: planning vs execution, analysis vs implementation, AI vs human control.

**Status:** Phase 7 complete — multi-user support (user-resolver, scoped memory, per-user tool/skill filtering, family assistant), subscription providers (Claude Agent SDK, Codex SDK), setup wizard, Telegram streaming fix, learner recommendations in prompt. Prior: MCP server, vector search (local embeddings), temporal decay, memory flush, minimal subagent prompts, heartbeat suppression, lazy skills, token management, cron scheduler, streaming, gates, hybrid memory search (FTS5), SQLite storage, tests (176), CI pipeline.

## Architecture

```
CLI/Telegram → MessageBus → AgentLoop → ProviderRegistry → Tools → Response
                                ↑              ↑               ↑
                          CronService        Database    spawn_agent → SubAgent
                          HeartbeatService (SQLite+FTS5)  Learner (metrics)
```

### Key modules (src/)
- `bootstrap.ts` — Shared `createApp()` init (used by both CLI and gateway)
- `agent/` — Agent loop (LLM iteration with tool calls), subagent spawning
- `bus/` — MessageBus + AsyncQueue (bounded, backpressure)
- `channels/` — CLI (interactive REPL), Telegram (grammy)
- `commands/` — onboard, gateway, mcp-server, setup (interactive wizard)
- `config/` — JSON config + Zod schema
- `context/` — System prompt builder (identity + EGO + project + skills + memory + learner)
- `db/` — SQLite database (better-sqlite3, WAL mode, numbered migrations)
- `gates/` — Pattern-based gate system (confirmation before destructive commands), CLI + Telegram gates
- `learner/` — Execution metrics (SQLite or JSONL fallback), keyword similarity, recommendations (wired into context prompt)
- `llm/` — Anthropic native + OpenAI-compatible + ClaudeAgent + Codex providers, ProviderRegistry (multi-provider with failover), streaming, SDK utils (structured output)
- `mcp/` — MCP server (JSON-RPC), stdio transport, tool bridge (exposes Janus tools to editors)
- `memory/` — MEMORY.md + daily notes + MemoryIndex (FTS5 + vector hybrid search with temporal decay), embedder (local @xenova/transformers)
- `services/` — CronService (persistent cron scheduler, SQLite), HeartbeatService (HEARTBEAT.md → CronService sync)
- `session/` — JSONL persistence, atomic writes, summarization
- `skills/` — SKILL.md loader (YAML frontmatter + markdown), lazy loading (stubs + read on demand)
- `tools/` — 8 built-in tools (exec, read/write/edit-file, list-dir, message, spawn_agent, cron)
- `users/` — User resolver (Telegram userId/username → Janus user), per-user profiles, tool/skill filtering

### Bootstrap files (unique to Janus)
- `~/.janus/EGO.md` — Agent character (global, static)
- `./JANUS.md` — Project-specific instructions (per-repo, like CLAUDE.md)
- `./AGENTS.md` — Agent behavior rules (per-workspace, customizable)
- `./HEARTBEAT.md` — Autonomous periodic tasks (per-workspace, supports `every Xm/h/d` and cron expressions)

## Commands

```bash
npm start                    # Interactive CLI
npm start -- -m "message"   # Single message
npm start -- gateway        # Headless (Telegram)
npm start -- onboard        # Init workspace
npm start -- mcp-server     # MCP server (stdin/stdout JSON-RPC)
```

## Config

`janus.json` (workspace) + env vars. Provider auto-detected from API key. Setup wizard on first run if no provider configured. `/config` command to reconfigure.

Two auth modes (mutually exclusive):
- **API Key** — openrouter, anthropic, openai, deepseek, groq (pay per token)
- **Subscription** — `claude-agent` (Claude Code Max via `claude login`), `codex` (ChatGPT Plus/Pro via `codex login`)

Key sections: `llm` (provider, model, multi-provider), `agent` (iterations, tokenBudget, contextWindow, skillLimits), `workspace`, `tools` (exec deny patterns), `database`, `heartbeat`, `telegram`, `streaming`, `gates`, `memory` (vectorSearch), `users` (profiles, tool/skill allow/deny), `family` (groupChatIds, shared scope).

## Dependencies

11 runtime: @anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk, @openai/codex-sdk, @xenova/transformers, better-sqlite3, chalk, croner, grammy, openai, yaml, zod
4 dev: @types/better-sqlite3, tsx, typescript, vitest

## Testing

```bash
npm test           # Run all tests (vitest)
npm run typecheck   # TypeScript type checking
```

176 tests across 21 test files: unit (async-queue, config-schema, context-builder, cron-service, cron-tool, gate-routing, heartbeat-parser, learner, mcp-server, memory-index, pattern-gate, provider-registry, sdk-utils, setup, skill-loading, streaming, system-message, token-counting, user-resolver, vector-search) + integration (agent-loop with mock LLM). CI runs on push/PR via GitHub Actions.

## Conventions

- TypeScript, ESM (`"type": "module"`)
- Code and comments in English
- No references to other projects in code
