# Pinned Skill State — Design Spec

**Status:** Final
**Date:** 2026-05-14
**Owner:** Wojciech Tokarzewski

## Goal

End the recurring "agent forgets operational state" bug by introducing a separate, file-backed memory path that bypasses session summarization and context compaction entirely.

## The Recurring Bug

Janus has shipped three rounds of summarization fixes:

- PRs **#187-189** — restore summarization quality with fallback chain
- PRs **#192-201** — summarization overhaul: tool results in input, retry chain removed, corrupt recovery, stream_flush, gate hardening, diet channel routing
- PRs **#203, #204, #207** — XML wrapping, assistant prefill, drop prefill, trailing whitespace

Each fix addressed *how* summarization runs. None addressed *what* it captures. The bug returned every time.

### Smoking gun (2026-05-14 19:58)

Telegram log captured in `src/llm/logi-pelne.md`:

```
19:56:04  Summarization: start (input ~81094 tokens)
19:57:32  Summarization: LLM call done in 88062ms
19:57:34  user: "nie tak, ostatni raz bralem kreatyne..."
19:57:44  user: "dzisiaj jest czwartek"
19:58:04  user: "przeciez juz pisalem co jadlem"
19:58:11  assistant: "Masz rację, przepraszam! Ale nie mam dostępu do
                      poprzednich wiadomości z tej sesji — każda
                      instancja agenta widzi tylko swój kontekst."
```

Within 10 minutes the same session ran **two** summarizations (19:48 and 19:57), each taking ~85-88 seconds. Each summary started identically: `## Goal\n## Goal\nWojtek prowadzi dziennik diety...`. The summary captured *intent* (lose weight by Adam's wedding) but lost *operational state* (today's logged meals: 4 eggs, hot dog, tortilla, bread, chicken, kombucha).

Context-budget Phase 2 (`hard-clear`) cleared all tool results — including the file reads that held today's diary contents. After summarization the model had a narrative summary plus the last 20k tokens of conversation (gym, creatine, weekday) but zero reference to the diary file. When asked "I already wrote what I ate", the model confabulated an architectural excuse instead of re-reading the source of truth.

## Root Cause

Janus mixes two kinds of memory in one channel:

| | Conversation memory (session) | Persistent memory (skill files) |
|---|---|---|
| Holds | Intent, decisions, narrative | Operational state (data) |
| Lifecycle | Grows → summarized → details lost | Stable, source of truth |
| Visibility to agent | Every LLM call | Only via fresh tool_result |
| After summarization | Compressed narrative | **Invisible** (tool_results cleared) |

Operational data lives in files (`food-diary/YYYY-MM-DD.md`, `profile.md`) but the agent only sees those files via tool_result messages, which Phase 2 hard-clear deletes. The summary is then asked to reconstruct everything in 4096 tokens — and predictably keeps the goal/strategy and drops the food log.

This is structural. It is not specific to diet-tracker. Any skill whose source of truth lives in files (gym log, meal plan, watchlist, project tracker) hits the same failure mode. Diet-tracker is just the most-used stateful skill, so the bug surfaces there first.

## Design

### Principle: two memories, two paths

- **Conversation memory** — session messages, summarization, context budget. Captures *intent* and *narrative*.
- **Persistent memory** — files on disk, declared by skills as `pinned:`. Loaded fresh into system prompt on every LLM call. Captures *operational state*.

These are loaded, compacted, and summarized independently. They never overwrite each other.

### Decision 1: Frontmatter declaration (explicit)

Skills declare pinned files in `SKILL.md` frontmatter:

```yaml
---
name: diet-tracker
description: "Diet tracking — logging meals, calories/macros, weigh-ins..."
version: "2.2.0"
always: false
pinned:
  - profile.md
  - food-diary/{today}.md
---
```

Explicit beats auto-detection. Five stateful skills × 30 seconds each is faster and more predictable than building auto-detection heuristics that themselves can fail.

If a future skill author forgets `pinned:`, the bug returns *for that skill only* and is fixed by adding one line. The blast radius is bounded.

### Decision 2: Skill activation is channel-aware (with universal-default fallback)

A skill is **active for pinning** in a chat when ANY of:
1. The skill is `always: true` (always-on skills).
2. The skill has a `skill-channels.json` preference AND that preference matches the current `(channel, chatId)`.
3. The skill has no `skill-channels.json` preference for this skill AND declares non-empty `pinned: [...]` in its frontmatter.

**Rule 3** is the universal default. It ensures pinned state works for users who haven't gone through a skill's "first use" channel-routing flow yet. Without it, every new installation would re-hit the bumerang for at least one message until `skill-channels.json` got populated.

**Rule 2 takes priority over Rule 3.** If the user explicitly set a channel preference (via the skill's first-use flow), we respect it — pinning is scoped to that chat only. If they later want pinning everywhere, they delete the preference.

For diet-tracker on a fresh install: no preference yet → Rule 3 activates pinning in every chat → after the first diet interaction, the skill writes `skill-channels.json` → from then on Rule 2 scopes pinning to the chosen chat. Smooth degradation.

### Decision 3: Refresh every LLM call

Pinned files are read from disk at the start of every LLM call. No caching layer, no `mtime` checks.

- File I/O cost: ~10ms per file × ~5 files = ~50ms. Negligible against 3-7 second LLM response time.
- Token cost: absorbed by Anthropic prompt cache (see Decision 6 for positioning). Within a 5-minute cache window, only the changed-file portion misses cache.
- Simplicity: no invalidation logic, no stale-cache risk, no edge cases on atomic writes / NFS / Docker volumes.

If profiling later shows I/O matters, swap in `mtime` checks punctually. YAGNI for now.

### Decision 4: Template syntax — fixed set

Pinned paths may contain:

- `{today}` — current local date `YYYY-MM-DD` in user's configured timezone
- `{yesterday}` — yesterday's date
- `{userId}` — sender's userId

Anything else is literal. No glob patterns, no per-skill resolver functions. If a real use case appears that doesn't fit, we extend.

### Decision 5: Missing files render as placeholder

When a pinned path doesn't exist on disk:

```xml
<file path="food-diary/2026-05-14.md" skill="diet-tracker" status="missing">
(file does not exist yet — will be created on first entry)
</file>
```

The agent sees the file is *expected* but empty. Combined with the anti-confab rule (Decision 8), this nudges the agent toward creating it or asking the user, not toward an excuse.

### Decision 6: No size cap, just observability

No hard or soft cap on file size. Trust the skill author.

One log line per pinned load:

```
[pinned] diet-tracker: 2 files, 4823 tokens loaded
```

If a buggy skill ever explodes a file to 100k tokens, the log is the first place to look. Until that happens — no preemptive engineering.

### Decision 7: Pinned content is excluded from summarization input

`doSummarization()` builds `rawConversation` from user/assistant/tool messages. Tool messages whose source was a pinned-file read are **dropped** from the summarization input.

This is the structural fix:

- Summary captures narrative ("Wojtek discussed creatine timing, decided to skip cardio")
- Pinned files capture state (today's food, weight, profile)
- Two paths, never merged, never compete for the 4096-token summary budget

Side benefit: summarization input shrinks (less to summarize → faster, cheaper, fewer `## Goal\n## Goal` artifacts).

### Decision 8: Anti-confabulation rule

Pinned state plus a behavioral rule. The bug's most painful symptom was the model inventing an architectural excuse ("nie mam dostępu do poprzednich wiadomości z tej sesji"). Pinning prevents 95% of those cases; the rule covers the rest.

Added to:

- `~/.janus/AGENTS.md` (global agent behavior, applies to every reply)
- `skills/diet-tracker/SKILL.md` (and any other stateful skill)

Wording (Polish/English mixed, matches existing AGENTS.md tone):

```
## State uncertainty

When the requested data is unclear, missing, or contradicts what you remember:

1. First, re-read the source of truth (the relevant file in `<pinned_skill_state>`,
   or call `read_file` if a pinned file is somehow missing).
2. If the file does not exist, is empty, or doesn't answer the question — ASK the user.
3. NEVER explain confusion in terms of memory limits, session boundaries, agent
   instances, summarization, or any other Janus internal. The user does not need
   to know how Janus works — they need an answer or a question.
```

### Decision 9: Per-user resolution

Pinned paths resolve relative to the **sender's** user files root:

```
.janus/users/{senderUserId}/files/{pinned path}
```

In a family chat, when Wojtek's wife messages, her diet files are pinned, not Wojtek's. For cron/heartbeat messages (no live sender), use the `userId` stored on the cron job (already present in the `cron_jobs` table since migration 6).

This matches the existing per-user file convention. No migration of existing diet files needed.

### Decision 10: Position in system prompt

Pinned state goes at the **end** of the system prompt, in a dedicated XML block:

```
[stable system content: identity, EGO, PROFILE, JANUS, MEMORY, tools, skill stubs]

<cache_control type="ephemeral"/>

<pinned_skill_state>
  <file path="food-diary/2026-05-14.md" skill="diet-tracker">
  ...contents...
  </file>
  <file path="profile.md" skill="diet-tracker">
  ...contents...
  </file>
</pinned_skill_state>
```

- Stable prefix gets a `cache_control` breakpoint → cache hit on the prefix even when pinned files change.
- Pinned section is the suffix of system prompt → cache miss is bounded to the pinned bytes and nothing else.
- When pinned files are unchanged (within the 5-min cache TTL), the whole system prompt is a single cache hit.

### Decision 11: Tool result interaction

No special deduplication. If a skill instructs the agent to `read_file profile.md` after we've already pinned it, the agent makes a redundant read; the tool_result lives one turn, gets cleared by the next Phase 2, no harm done.

Stateful skill `SKILL.md` files are updated to reference `<pinned_skill_state>` instead of issuing `read_file` for already-pinned files. Best-effort improvement, not load-bearing.

## Affected Code

| File | Change |
|---|---|
| `src/skills/loader.ts` | Parse `pinned:` from SKILL.md frontmatter, validate template variables |
| `src/config/schema.ts` | Add `pinned: string[]` to SKILL.md frontmatter schema |
| `src/agent/agent-resolver.ts` (or wherever skill activation lives) | Add channel-preference check to activation logic |
| `src/context/` (system message builder) | New `buildPinnedSection()` — reads files, substitutes templates, renders XML block, logs token count |
| `src/agent/agent-loop.ts` (`doSummarization`, ~line 1264) | Exclude pinned-file reads from `rawConversation` |
| `src/llm/anthropic-provider.ts` | Verify `cache_control` breakpoint position (insertion point before pinned section) |
| `~/.janus/AGENTS.md` template | Add "State uncertainty" section |
| `skills/diet-tracker/SKILL.md` | Add `pinned:` frontmatter, replace "read profile.md" instructions with "see `<pinned_skill_state>`", bump version to 2.2.0 |

## Code Comment Plan

Three targeted comments, per CLAUDE.md "only write WHY when non-obvious":

1. **In `buildPinnedSection()`** (top of function):
   ```
   // Pinned files bypass summarization and live in system prompt to survive
   // context compaction. See docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md.
   ```

2. **In `SKILL.md` schema** at the `pinned` field:
   ```
   // Files listed here are read from disk every LLM call and injected into the
   // system prompt — survives summarization. Supports {today}/{yesterday}/{userId}.
   ```

3. **In `doSummarization()`** at the pinned-exclusion filter:
   ```
   // Pinned-file tool_results are dropped: their content is re-injected fresh on
   // every call, so summarizing a stale snapshot of them adds nothing and dilutes
   // the narrative budget.
   ```

## Migration

Single shippable PR. No data migration. Backward-compatible for all skills:

- Skill without `pinned:` → loader treats it as `[]` → no pinned section for that skill → existing behavior unchanged.
- Skill with `pinned:` → loads files, injects, excludes from summarization.

`skills/diet-tracker/SKILL.md` updated as part of the PR (it's the proof-of-concept user). Other stateful skills get `pinned:` added in follow-up PRs as needed.

## Troubleshooting Runbook

For future debugging when the bumerang seems to return:

**Symptom: agent claims it doesn't know today's state**

1. Check the system prompt sent to LLM (debug log) — is `<pinned_skill_state>` present?
2. If no — verify the skill is **active** for this turn:
    - Channel matches `skill-channels.json` for this skill? **OR**
    - Message text matches skill `description` keywords?
   If neither, the skill won't activate → no pinning. Add the channel mapping or broaden the description.
3. If `<pinned_skill_state>` present but content is wrong: check date templating. Is `{today}` resolving to the user's local date? `localDate()` uses configured `timezone` — if unset, falls back to system, which may differ in Docker.
4. If file content is correct but agent still confabulates: behavioral problem, not state problem. Check `~/.janus/AGENTS.md` has the "State uncertainty" section.

**Symptom: pinned content is stale**

Refresh-every-call should make this impossible. If it happens:

1. Verify no caching layer was added (Decision 3 says no caching).
2. Check file `mtime` on disk — did the write actually land?
3. Look for `[pinned]` log line with the expected token count — if missing, loader silently failed.

**Symptom: token count spiking**

1. Look for the `[pinned]` log line in the call that spiked — which skill, which file?
2. If a single file is >10k tokens, the skill has a state-accumulation problem (no archive/rotate policy). Fix the skill, not the infrastructure.
3. If many small pinned files (>10), the skill is over-pinning. Trim the frontmatter to just the live state files.

**Symptom: cache hit rate dropped**

1. Pinned content changes every call → check why (file should only change when user logs something).
2. Verify `cache_control` breakpoint is positioned **before** pinned section, not after. After = no cache hit on the stable prefix.

## Open Questions / Future Work

- **Glob patterns for "last N daily files"** — meal-planner might want last 3 days of meals pinned. Defer until a real ask appears.
- **Pinning shared (not per-user) files** — none of the current skills need this. Defer.
- **Pinning content from skill's own directory** — `pinned: ./templates/onboarding.md`. Not needed for state — that's static content that fits in SKILL.md itself.
- **Token cap if pinned files explode** — defer until we see realistic growth pattern. Decision 6 ships with observability only.

## Success Criteria

1. Smoking gun repro fails to reproduce. With pinned state in the diet chat, the agent answers `przeciez juz pisalem co jadlem` correctly by referencing the contents of `food-diary/{today}.md`.
2. No regression in non-diet conversations (`<pinned_skill_state>` absent when no pinned-enabled skill is active).
3. `[pinned]` log line appears on every diet-chat message with expected token counts.
4. Anthropic cache hit rate (memory baseline: 88%) does not degrade.
5. Tests added for: template substitution, missing-file placeholder, channel-aware activation, summarization exclusion.
