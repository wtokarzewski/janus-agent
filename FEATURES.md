# Features

Canonical list of implemented, working features. Verified against source code and 176 passing tests.

**Last updated:** 2026-02-23

## Agent Core

- **Flat agent loop** — LLM decides what to do, tools execute, loop repeats until done. No rigid pipeline or pre-classification.
- **Subagent spawning** — `spawn_agent` tool creates child AgentLoop with isolated session. Minimal prompt mode (identity + skills + session only) saves tokens.
- **Emergency compression** — On context overflow, drops oldest 50% of messages and retries (up to 2x).
- **Token-based summarization** — When session tokens exceed 75% of budget, triggers async summarization.
- **Memory flush before compaction** — Before summarization discards old messages, LLM extracts key facts into daily notes. Preserves knowledge across compaction.
- **No-op suppression** — Heartbeat/cron responses like "HEARTBEAT_OK" are not routed to the user.

## LLM Providers (7)

Two auth modes (mutually exclusive):

| Provider | Type | Protocol |
|----------|------|----------|
| `openrouter` | API key | OpenAI-compatible |
| `anthropic` | API key | Anthropic native |
| `openai` | API key | OpenAI-compatible |
| `deepseek` | API key | OpenAI-compatible |
| `groq` | API key | OpenAI-compatible |
| `claude-agent` | Subscription (Claude Code Max) | @anthropic-ai/claude-agent-sdk |
| `codex` | Subscription (ChatGPT Plus/Pro) | @openai/codex-sdk |

- **Multi-provider failover** — Priority-ordered list, automatic fallover on error. Purpose-based routing (chat, summarize, flush).
- **Streaming** — `chatStream()` on Anthropic + OpenAI-compatible providers. Real-time chunk delivery via MessageBus to CLI and Telegram.
- **Structured output** — Subscription providers use JSON schema enforcement via `sdk-utils.ts` (~99% reliability + fallback parsing).
- **Setup wizard** — Interactive first-run config. Detects API key vs subscription. `/config` command for reconfiguration.

## Tools (8)

| Tool | Description |
|------|-------------|
| `exec` | Shell commands. Deny patterns (rm -rf, mkfs, fork bomb, etc.). Configurable timeout. |
| `read_file` | Read file contents with size limit. |
| `write_file` | Create/overwrite files with atomic writes. |
| `edit_file` | Find-and-replace in files. |
| `list_dir` | List directory contents. |
| `message` | Send message to user via bus. |
| `spawn_agent` | Spawn child agent for subtasks (minimal prompt, isolated session). |
| `cron` | Create, list, delete persistent cron jobs. |

## Memory System

- **MEMORY.md** — Persistent knowledge file. Agent reads/writes via tools. Evergreen in search ranking.
- **Daily notes** — `memory/YYYY-MM-DD.md`. Auto-populated by memory flush before compaction.
- **FTS5 search** — SQLite full-text search with BM25 ranking.
- **Vector search** — Local embeddings via `@xenova/transformers` (all-MiniLM-L6-v2, 384-dim, ONNX). Zero API cost. Opt-in via `memory.vectorSearch` config.
- **Hybrid search (RRF)** — Reciprocal Rank Fusion combining FTS5 + vector results.
- **Temporal decay** — 30-day half-life. Recent content ranks higher. MEMORY.md chunks exempt (evergreen).
- **Scope filtering** — Memory chunks tagged with owner/scope for multi-user isolation.

## Channels (2 + MCP)

| Channel | Features |
|---------|----------|
| **CLI** | Interactive REPL, single-message mode (`-m`), inline streaming output, gate confirmation via readline. |
| **Telegram** | Grammy bot, user allowlist, streaming via edit-in-place (throttled), gate confirmation via inline keyboard. |
| **MCP** | JSON-RPC 2.0 over stdio. Exposes tools to editors (VS Code, Cursor, Claude Code). |

## Gates (Safety)

- **PatternGate** — Regex-based confirmation before destructive `exec` commands.
- **Default patterns:** `rm`, `git push`, `git reset`, `npm publish`, `docker rm`.
- **CLIGate** — Readline yes/no confirmation.
- **TelegramGate** — Inline keyboard (Approve / Deny) confirmation.
- **Wired into ToolRegistry** — Gate check runs before every tool execution.

## Scheduling

- **CronService** — SQLite-backed persistent scheduler. Survives restarts.
  - 3 schedule kinds: `at` (one-shot), `every` (interval), `cron` (expression via croner).
  - Run history tracking, exponential backoff on consecutive errors.
- **HeartbeatService** — Parses `HEARTBEAT.md` for periodic tasks.
  - Supports `every Xm/h/d` and cron expressions.
  - Syncs to CronService when available, falls back to in-memory timers.

## Multi-User (partial)

- **UserResolver** — Resolves inbound message sender to user profile by channel + ID.
- **Per-user profiles** — `~/.janus/users/{userId}/PROFILE.md` with name, identities, tool/skill allow/deny lists.
- **Per-user memory** — Scoped memory chunks (owner + scope filtering in MemoryIndex).
- **Family groups** — Shared memory scope via `family.groupChatIds` config.
- **Wired into AgentLoop** — User profile passed to context builder, tool context, learner.
- **Not yet complete:** Tool policy enforcement (domain filters, content rating) is schema-only.

## Learner

- **Execution metrics** — Records task, duration, iterations, tool calls, token usage, outcome per agent run.
- **SQLite storage** (primary) with JSONL fallback.
- **Keyword similarity** — Finds similar past tasks by keyword overlap.
- **Recommendations** — Returns avgDuration, avgIterations, avgToolCalls, successRate from similar executions.

## Skills

- **SKILL.md format** — YAML frontmatter (name, description, always, requires) + markdown body.
- **3-source loading** — workspace/skills → ~/.janus/skills → builtin/skills.
- **Lazy loading** — Skills emit XML stubs with `location` attribute. Agent reads full content on demand via `read_file`. `always: true` skills inlined.
- **Config limits** — `maxSkillsInPrompt`, `maxSkillsPromptChars`.

## Sessions

- **JSONL persistence** — One message per line, atomic writes (write-then-rename).
- **Summarization** — Async, non-blocking. Triggered by token budget threshold.
- **History trimming** — Old messages compacted after memory flush.

## Bootstrap Files

| File | Scope | Purpose |
|------|-------|---------|
| `~/.janus/EGO.md` | Global | Agent character and personality |
| `./JANUS.md` | Per-repo | Project-specific instructions (like CLAUDE.md) |
| `./AGENTS.md` | Per-workspace | Agent behavior rules |
| `./HEARTBEAT.md` | Per-workspace | Autonomous periodic tasks |

## Database

- **SQLite** (better-sqlite3), WAL mode, numbered migrations.
- **4 migrations:** memory_chunks + FTS5, learner_records, cron_jobs + cron_runs, embedding column.
- **Graceful fallback** — File-based storage when database disabled.

## Infrastructure

- **MessageBus** — AsyncQueue with bounded capacity and backpressure.
- **Shared bootstrap** — `createApp()` in `bootstrap.ts` eliminates duplication between CLI and gateway.
- **Config** — `janus.json` + env vars, Zod-validated schema, `saveConfig()` for persistence.
- **CI** — GitHub Actions (typecheck + vitest on push/PR).
- **Tests** — 176 tests across 21 files (vitest, mock LLM, in-memory SQLite).

## Not Implemented

Features explicitly **not** in Janus (some may come later):

- Web search / web fetch tools
- MCP client (connecting to external MCP servers)
- Browser automation
- Voice / audio transcription
- Channels beyond CLI + Telegram (no Discord, WhatsApp, Slack, etc.)
- Plugin / hook system
- Native apps (macOS, iOS, Android)
- Web UI
- Skills source ?
