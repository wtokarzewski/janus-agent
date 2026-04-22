# Changelog

All notable changes to Janus are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.0] - 2026-04-22

### Added
- `--token-debug` CLI flag for per-request token breakdown on stdout (cache read/write, hit rate, CACHE MISS warnings)
- `background` context mode for cron/heartbeat jobs (skips memory, learner, HEARTBEAT.md, JANUS.md — keeps EGO, AGENTS for personality)
- Static/dynamic system prompt split for Anthropic prompt cache optimization
- `cache_control: ephemeral` on last user message (improves cache hit rate)
- `fine-grained-tool-streaming-2025-05-14` beta header
- Heartbeat parser supports `- chat:` field for group chat routing
- `diet-tracker` skill

### Changed
- Memory flush consolidated from 3 triggers to 1 (token-aware at 40% budget)
- Anthropic SDK upgraded 0.77.0 → 0.90.0
- User-agent bumped to `claude-cli/2.1.104`
- Version scheme changed from 1.0.0 to 0.x.0 (pre-stable)

### Removed
- Idle memory flush timer (120s)
- Count-based memory flush (every 5 messages)
- Summarization quality retry (scheduling keyword heuristic)

### Fixed
- Heartbeat `- chat:` field not passed to cron jobs (notifications went to wrong channel)
- `--token-debug` flag not working via `npm start` wrapper (process.argv fallback)
- Competitor reference in spec doc removed

## [0.13.0] - 2026-04-19

Formerly 1.0.0. Renumbered to reflect pre-stable status.

### Added
- Universal AI agent with CLI, Telegram, and Browser Operator channels
- Multi-provider LLM support (Anthropic, OpenAI, Codex) with failover
- Multi-agent routing with per-agent config, tools, memory isolation
- Cron scheduler with owner+targets model and auto-cleanup
- Heartbeat service for periodic autonomous tasks
- Memory system (FTS5 + vector hybrid search, temporal decay, auto-flush)
- Session management (JSONL, summarization, context budget)
- 15 built-in tools (exec, file ops, web_fetch, web_search, browser, cron, spawn_agent, etc.)
- Browser Operator via Playwright persistent context
- MCP server and client support
- Security hardening (SSRF guard, prompt injection tags, secret redaction, credential encryption)
- Gate system (pattern-based tool access control, audit log)
- Multi-user privacy (per-user cron, file access control, context isolation)
- Native OAuth (PKCE) for Anthropic and Codex
- Voice transcription (Groq Whisper)
- Backup, restore, and doctor commands
- Orphan surrogate sanitization for API compatibility
- 545+ tests across 48 test files
