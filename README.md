# Janus

[![CI](https://github.com/wtokarzewski/janus-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/wtokarzewski/janus-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Universal AI agent — autonomous digital worker for any domain.

**Name:** Janus — Roman god of beginnings, transitions, and duality. Two faces looking to the past and the future.

## What it does

Janus is a personal AI agent that runs locally, connects via CLI or Telegram, and autonomously executes tasks using tools (shell, files, subagents, cron). It remembers context across sessions, learns from past executions, and asks for confirmation before destructive actions.

```
CLI/Telegram → MessageBus → AgentLoop → ProviderRegistry → Tools → Response
                                ↑              ↑               ↑
                          CronService        Database    spawn_agent → SubAgent
                          HeartbeatService (SQLite+FTS5)  Learner (metrics)
```

## Quick Start

```bash
git clone https://github.com/wtokarzewski/janus-agent.git
cd janus-agent
npm install
npm start                    # Interactive CLI
npm start -- -m "message"   # Single message
npm start -- gateway        # Headless (Telegram bot)
npm start -- onboard        # Init workspace (EGO.md, AGENTS.md, etc.)
npm start -- mcp-server     # MCP server for editor integration
```

On first run, setup wizard detects missing config and guides you through provider selection.

## Config

`janus.json` in workspace root. Two auth modes:

- **API Key** — openrouter, anthropic, openai, deepseek, groq
- **Subscription** — `claude-agent` (Claude Code Max), `codex` (ChatGPT Plus/Pro)

Run `/config` during a session to reconfigure. See `examples/janus.json` for a config template.

## Key Features

- **7 LLM providers** with multi-provider failover and streaming
- **8 built-in tools** — exec, read/write/edit-file, list-dir, message, spawn_agent, cron
- **Hybrid memory search** — FTS5 + vector (local embeddings, all-MiniLM-L6-v2) + temporal decay
- **Safety gates** — Pattern-based confirmation before destructive commands
- **Persistent cron** — SQLite-backed scheduler with heartbeat tasks
- **Subagent spawning** — Child agents with minimal prompts for parallel work
- **Learner** — Execution metrics with keyword-based recommendations
- **MCP server** — Expose tools to editors via JSON-RPC over stdio
- **Multi-user** — Per-user profiles, memory scoping, tool/skill restrictions
- **Lazy skills** — SKILL.md files loaded on demand to save tokens

See [FEATURES.md](FEATURES.md) for the full verified feature list.

## Memory & Vector Search

Janus stores long-term memory as markdown files (`memory/MEMORY.md` + daily notes) indexed into SQLite FTS5 for fast full-text search with BM25 ranking and temporal decay (30-day half-life, MEMORY.md chunks are evergreen).

**Vector search** adds semantic similarity on top of FTS5. It runs entirely locally — no API calls, no cost:

- Uses `@xenova/transformers` with the `all-MiniLM-L6-v2` model (384-dim, ONNX)
- On first run, the model downloads automatically (~23MB, cached afterwards)
- At startup, embeddings are computed in the background (non-blocking)
- At query time, results from FTS5 and vector search are fused via Reciprocal Rank Fusion (RRF)
- If embeddings aren't ready yet, gracefully falls back to FTS5 only

To enable, add to `janus.json`:

```json
{
  "memory": {
    "vectorSearch": true
  }
}
```

Disabled by default to avoid the initial model download on machines where it's not needed.

## Documentation

| Document | Description |
|----------|-------------|
| [FEATURES.md](FEATURES.md) | Canonical list of implemented features |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture and module details |
| [ROADMAP.md](docs/ROADMAP.md) | Phase history and future plans |
| [SKILLS-FORMAT.md](docs/SKILLS-FORMAT.md) | SKILL.md format specification |
| [PATTERNS.md](docs/PATTERNS.md) | Design patterns (Q&A, gates, error handling) |

## Testing

```bash
npm test           # 176 tests across 21 files (vitest)
npm run typecheck   # TypeScript type checking
```

CI runs on push/PR via GitHub Actions.

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
