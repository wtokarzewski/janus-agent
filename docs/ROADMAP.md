# Roadmap

## Current State (Phase 7 complete)

- **Codebase:** ~6,000 LOC TypeScript, 176 tests across 21 files, CI
- **Runtime deps:** 11 (@anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk, @openai/codex-sdk, @xenova/transformers, better-sqlite3, chalk, croner, grammy, openai, yaml, zod)
- **Providers:** 7 (openrouter, anthropic, openai, deepseek, groq, claude-agent, codex)
- **Tools:** 8 (exec, read/write/edit-file, list-dir, message, spawn_agent, cron)
- **Skills:** 1 (programmer)
- **Channels:** 2 (CLI, Telegram) + MCP server
- **DB:** SQLite (WAL, 4 migrations: memory_chunks+FTS5, learner_records, cron_jobs+cron_runs, embedding)

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

**Remaining:**
- Tool policy enforcement (domain filters, content rating) — schema exists, enforcement stubbed

---

## Future Candidates

### High priority (low effort, high value)
- **MCP client** — Connect to external MCP servers.
- **Web search + web fetch tools** — Brave API / DuckDuckGo.
- **Voice transcription** — Groq Whisper (free) for Telegram voice messages.

### Medium priority
- **More channels** — Discord, WhatsApp, Slack. ~300-600 lines each with good abstraction.
- **New skills** — Researcher (web search + synthesis), writer (docs, reports).
- **Q&A Loop** — Structured requirements-gathering dialog before execution.
- **More gate coverage** — Gate on file writes to sensitive paths, gate on spawn_agent.
- **Web UI** — Browser-based chat interface.

### Low priority
- **Skill self-creation** — Agent creates new SKILL.md files from repeated tasks.
- **Browser automation** — Headless Chrome for web tasks.
- **Plugin / hook system** — Extensibility points for third-party code.
- **Docker packaging** — Containerized deployment.
- **Native apps** — macOS, iOS, Android.

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

- **Local embeddings** — all-MiniLM-L6-v2 via ONNX. Zero API cost, zero latency. Most agents use cloud APIs or skip vector search entirely.
- **Hybrid search (FTS5 + vector + RRF)** — keyword AND semantic search combined with temporal decay.
- **Learner** — Records execution metrics and provides keyword-based recommendations.
- **Memory flush before compaction** — Preserves knowledge during session summarization.
- **Minimal subagent prompts** — Child agents get stripped context, saving tokens.
- **Persistent cron scheduler** — SQLite-backed, survives restarts, exponential backoff.
- **MCP server** — Editors can use Janus tools directly via reverse provider.
- **Simplicity** — ~6K LOC. Minimal codebase, full capabilities.
