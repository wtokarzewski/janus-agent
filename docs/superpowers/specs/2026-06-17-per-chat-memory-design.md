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
- **No migration of existing memory.** `users/*/memory/` stays LIVE (read/written for DMs) — nothing changes there. Only the root workspace `memory/` (the old group/family dump) is left on disk and no longer auto-read, since group chats now write to `chats/{chatId}/`. Wojtek deletes that root pile manually when ready.
- **No new config toggle.** Per-chat is the default behavior (keep it simple). Consequence noted below.

## Design

### Directory layout
- Episodic per chat: `.janus/chats/{chatId}/memory/MEMORY.md` + `{date}.md`.
- Unchanged per user: `.janus/users/{userId}/PROFILE.md`, `files/`, `HEARTBEAT.md`.
- **Per-user memory is preserved and stays live.** Direct/personal (DM) conversations keep reading and writing `.janus/users/{userId}/memory/` — each user has their own memory, unchanged. Only GROUP/family chats change: their memory moves from the old global `memory/` dump to `.janus/chats/{chatId}/memory/`.
- Legacy (retained on disk, no longer read): the root workspace `memory/` ONLY — it was the shared dump for group/family scope, now replaced by per-chat dirs. `users/*/memory/` is NOT legacy — it stays live for DMs.

### Resolution: scopeForChat → resolveMemDir
`scopeForChat({ scope, userId, chatId, agentId })` picks the key from the message context — **the key is NOT always the chat:**
- isolated agent (`memory.shared:false`) → `{ agentId }`
- direct/personal message (`scope.kind === 'user'`) → `{ userId }` — **DMs keep their own per-user memory**
- group/family chat (`scope.kind === 'family'`) → `{ chatId }`
- no context → `{}` (global)

`resolveMemDir(scope: MemoryScope)` maps it, precedence agent > chat > user > global:
1. `agentId` → `.janus/agents/{agentId}/memory/`
2. `chatId` → `.janus/chats/{chatId}/memory/`
3. `userId` → `.janus/users/{userId}/memory/`
4. global `memory/`

All read/write methods (`readMemory`, `writeMemory`, `appendDaily`, `readDaily`, `getRecentDailyNotes`, `getContext`) take a `MemoryScope`.

### Threading the scope
- `AgentLoop.flushState` gains `chatId` (alongside `userId`/`userName`/`scope`). `flushMemory()` computes `scopeForChat({ scope: state.scope, userId, chatId })` and passes it to `readMemory`/`appendDaily` — so a DM's notes land under `users/{userId}/` and a group's under `chats/{chatId}/`.
- `ContextBuilder.buildMemorySection` computes the same scope and passes it to `getContext()` (direct reads) **and** `memory.search()` (retrieval).

### Search / index scoping
- `collectMemoryFiles` indexes `chats/{chatId}/memory/` as `scope='chat', scope_id=chatId`, and keeps `users/{id}/memory/` as `scope='user', scope_id=userId`.
- `MemoryStore.search`/`hybridSearch` → `MemoryIndex.search(query, limit, scope)` filter STRICTLY to the resolved scope's chunks (chat→chat, user→user, no cross-scope merge). Closes the retrieval-bleed path.
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
