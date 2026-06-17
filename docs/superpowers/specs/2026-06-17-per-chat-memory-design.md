# Per-chat memory scoping

**Date:** 2026-06-17
**Status:** Design approved (verbally); pending spec review
**Branch:** `feat/per-chat-memory`

## Problem

Persistent memory has no per-chat dimension. `MemoryStore.resolveMemDir(userId?, agentId?)` resolves to **agent > user > global** — never per chat. So all of one user's channels share a single memory bucket (`users/{userId}/memory/` or the workspace-global `memory/`), and content bleeds across channels: e.g. Wojtek's dedicated "diet" chat leaks into his main chat.

The workspace-root `memory/` also accumulates every family-group and heartbeat daily note (months of files), because `flushMemory()` routes by `scope` — `family`/global scope lands in the global dir.

Two read paths feed the system prompt, so **both** must be scoped or the bleed persists:
- `MemoryStore.getContext()` — direct reads of `MEMORY.md` + recent daily notes (`context-builder.ts:492`).
- `MemoryStore.search()` → `MemoryIndex.search()` — FTS5/vector retrieval (`context-builder.ts:464`).

## Goal

Scope episodic memory by **chat**: `.janus/chats/{chatId}/memory/` holding `MEMORY.md` + `{YYYY-MM-DD}.md` daily notes, shared by everyone in that chat. Both read paths (direct + search) scope to the current chat. This isolates the diet chat from the main chat and stops the global dir from collecting family/heartbeat notes.

`PROFILE.md`, `files/`, `HEARTBEAT.md` stay per-user, unchanged. Division of responsibility:
- **`PROFILE.md` (per user)** = stable "who this person is" — always loaded.
- **chat memory (per chat)** = episodic "what happened in this channel".

## Out of scope (explicitly decided)

- **No retention/pruning of daily notes.** Daily `.md` files are KB-scale; the real problem is bleed (fixed by routing), not volume. Index temporal decay already down-weights old chunks. Revisit only if chat dirs genuinely balloon.
- **No migration of existing memory.** Clean break: existing `users/*/memory/` and root `memory/` are left on disk (nothing deleted) and no longer auto-read. Wojtek deletes the old root pile manually.
- **No new config toggle.** Per-chat is the default behavior (keep it simple). Consequence noted below.

## Design

### Directory layout
- Episodic per chat: `.janus/chats/{chatId}/memory/MEMORY.md` + `{date}.md`.
- Unchanged per user: `.janus/users/{userId}/PROFILE.md`, `files/`, `HEARTBEAT.md`.
- Legacy (retained on disk, not read): root `memory/`, `users/*/memory/`.
- DMs are chats too: a private chat's memory goes to `chats/{dmChatId}/memory/` (on Telegram a private chat's id equals the user's id, so DM memory stays naturally per-person). Episodic memory thus moves off `users/{userId}/memory/` entirely; only `PROFILE.md`/`files/`/`HEARTBEAT.md` remain under `users/`.

### Resolution precedence
`resolveMemDir({ chatId?, userId?, agentId? })`:
1. `agentId` — only passed when an agent opts into isolated memory (`memory.shared: false`) → `.janus/agents/{agentId}/memory/`. **Preserves the existing per-agent isolation feature.**
2. `chatId` → `.janus/chats/{chatId}/memory/`. **New — the normal path.**
3. `userId` → `.janus/users/{userId}/memory/`. Legacy fallback.
4. global `memory/`. Fallback when there is no chat (e.g. a chatless internal context).

All read/write methods (`readMemory`, `writeMemory`, `appendDaily`, `readDaily`, `getRecentDailyNotes`, `getContext`) accept `chatId` and route via `resolveMemDir`. `appendDaily`'s current inline routing is unified to use `resolveMemDir`.

### Threading `chatId`
- `AgentLoop.flushState` gains `chatId` (alongside `userId`/`userName`/`scope`). Source: the inbound message, or parsed from the session key (`{agentId}:{channel}:{chatId}`).
- `flushMemory()` passes `chatId` to `appendDaily`, so flushed daily notes land in the originating chat's dir.
- `ContextBuilder` passes `chatId` to `getContext()` (direct reads) **and** to `memory.search()` (retrieval).

### Search / index scoping
- `MemoryIndex` tags each chunk with the `chatId` derived from its file path (`chats/{chatId}/memory/...`). Chunks from legacy user/global memory carry no `chatId`.
- `MemoryStore.search(query, limit, chatId)` → `MemoryIndex.search(query, limit, chatId)` filters results to the current chat's chunks. This closes the retrieval-bleed path.
- Indexing walks `chats/*/memory/` and tags accordingly.

### Behavior consequence
Per-chat becomes the default for all deployments, so on upgrade the effective memory location changes for everyone — not just Wojtek. Old memory is preserved on disk (clean break), so nothing is lost, but each chat's memory starts fresh and rebuilds. This warrants a CHANGELOG / upgrade note. Accepted: the pooled memory was the bug.

## Testing (TDD)
- `resolveMemDir` precedence: `chatId` → `chats/{chatId}`; isolated `agentId` wins; `userId`/global fallback when no `chatId`.
- `appendDaily` / `writeMemory` / `readMemory` / `getContext` write and read under `chats/{chatId}/`.
- **Cross-chat isolation:** write memory in chat A, read from chat B → not present.
- **Search isolation:** index a chunk from chat A → `search(..., chatId=B)` does not return it; `search(..., chatId=A)` does.
- `flushMemory` routes daily notes to the originating chat's dir (chatId threaded end-to-end).
- Fallback: no `chatId` → global dir (chatless context still works).

## Files affected
- `src/memory/memory-store.ts` — `resolveMemDir` + read/write methods + `search` signature.
- `src/memory/memory-index.ts` — chunk `chatId` tagging, search filter, indexing walk.
- `src/agent/agent-loop.ts` — `flushState.chatId`, `flushMemory` threads `chatId`.
- `src/context/context-builder.ts` — pass `chatId` to `getContext` + `search`.
- `src/bootstrap.ts` — indexing walk over `chats/*/memory/` if needed.
- Tests: `memory-store`, `memory-index`, `context-builder` / agent-loop integration.
- No `janus.example.json` / schema change (per-chat is default; no new config).
