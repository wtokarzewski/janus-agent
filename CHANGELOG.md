# Changelog

All notable changes to Janus are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-04-19

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
