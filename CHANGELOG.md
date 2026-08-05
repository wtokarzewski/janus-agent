# Changelog

All notable changes to Janus are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.0] - 2026-08-05

### Added
- **Context management redesign** — one pre-call router (fits / truncate / compact / both) replaces the 7-mechanism, 12-threshold cascade that had accumulated 20+ patch PRs; transcript rotation keeps sessions bounded on disk, and a single tool-result cap ends the 100x disk-vs-memory mismatch (#212)
- **Pinned skill state** — files listed in a skill's `pinned:` frontmatter survive summarization, so the agent stops forgetting long-running state (#208, #210, #211)
- **Provider circuit breaker** — a provider failing repeatedly is skipped for a cooldown instead of being retried first on every message; `llm.circuitBreaker`, defaults 2 failures / 5 min (#234)
- **`/provider`** — numbered menu of configured providers (role, model, which one is serving, which the breaker demoted); reply with a number to switch, `0` for automatic. Runtime pin: no restart, not written to config, overrides a demotion on purpose (#245)
- **Update announcement** — after any successful update every configured user gets a DM with a build stamp (`v0.15.0 • 6e1ed1f • 2026-08-05 21:14`) and the commits that landed; manual `update` now writes the same marker `self_update` did (#245)
- **Model drift check** — `update` compares configured models against each provider's live list and warns about retired ones (#242)
- **New models** — Sonnet 5, Opus 4.8/4.7, Fable 5 (#229); Opus 5 and the GPT-5.6 family with Terra as the default, `reasoningEffort` widened to `none|low|medium|high|xhigh|max` (#237)
- **File logging with daily rotation** — opt-in `.janus/logs/YYYY-MM-DD.log`, secrets masked, old files pruned (#218)
- **Per-chat memory** — group chats keep their own memory and files (#220)
- **Embedding cache** keyed by content hash — startup reindex no longer recomputes every chunk (#233)
- **Config sync on update** — new config sections are added to `janus.json` automatically, including when already up to date (#219, #221, #222)
- **Skill channel preferences** and the diet-tracker skill (#190, #191)

### Fixed
- **Auth** — an expired OAuth refresh now fails over to the fallback provider instead of parking the agent on a dead credential (#236); refresh is single-flight per provider, so concurrent lanes stop invalidating each other's single-use tokens, and a genuinely dead credential DMs the owner instead of logging a warning nobody reads (#241); the OAuth callback socket is dropped so `setup` can exit (#240)
- **Cron delivery** — root cause of the "no reminders" outage: lane watchdog, queue telemetry, HEARTBEAT.md re-sync without restart, per-user memory scope for DM-delivered jobs, gateway instance lock and a bounded shutdown (#224, #225, #226)
- **Telegram** — a Bot API outage no longer blocks cron and heartbeat at startup (#232); no more message duplication during tool calls (#197)
- **Windows** — `exec` reports a timeout without waiting for the OS to tear the process tree down, which used to hang the suite and make auto-update revert a good pull; the update path now distinguishes a real test failure from a runner that never finished, and reverts to the pre-pull commit rather than `HEAD~1` (#244, #228)
- **Summarization** — tool results included in the input, retry chain removed, corrupt summaries discarded, trailing whitespace stripped from the final assistant message, XML-wrapped prompts (#187, #188, #192, #198, #200, #201, #203, #204, #207)
- **Setup** — the fallback provider is verified too, not just the primary (#243)
- **Agent loop** — breaks when every tool call in a round is a duplicate (#206); typing indicator no longer leaks after streaming (#202)
- **Cron tool** — `chat_id` defaults structurally from the conversation, stale time anchors are relabelled, `runs` output explains ambiguous fields (#216)
- Surrogate-safe truncation and orphan surrogate stripping at the provider boundary (#223)

### Changed
- `agent.contextWindow` example raised 128000 → 1000000 and the dead `agent.tokenBudget` removed — nothing had read it since the context redesign (#238)
- Setup wizard model lists and defaults refreshed to the current generation; superseded short aliases dropped (#237)
- `/provider` and `/model` moved behind the allowlist check — they used to run before it, so an unknown sender could change the model for every chat (#245)

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
- External project reference in spec doc removed

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
