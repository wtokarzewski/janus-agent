# Pinned Skill State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate, file-backed memory path that bypasses session summarization and context compaction, eliminating the recurring "agent forgets operational state" bug.

**Architecture:** Skills declare a `pinned: string[]` array in their SKILL.md frontmatter. On every LLM call, the context builder reads those files fresh from disk (with `{today}`/`{yesterday}`/`{userId}` template substitution), renders them as a `<pinned_skill_state>` XML block at the end of the system prompt, and emits the relevant pinned paths so the summarization step can exclude their tool_result reads from its input. Activation is channel-aware: a skill's pinned files load when the current chat matches its `skill-channels.json` entry, or unconditionally for `always: true` skills.

**Tech Stack:** TypeScript, ESM, Vitest. No new dependencies.

**Reference:** Design spec at `docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md` — read it before starting.

---

## File Structure

**New files:**
- `src/context/pinned-state.ts` — pure module: takes skills + context, returns `{ xml, pinnedPaths }`
- `tests/unit/pinned-state.test.ts` — unit tests for the module

**Modified files:**
- `src/skills/types.ts` — add `pinned?: string[]` to `SkillDefinition`
- `src/skills/skill-loader.ts` — parse `pinned` from frontmatter (line 150 area)
- `src/context/context-builder.ts` — invoke `buildPinnedStateSection`, inject into `dynamicParts` after skill channels (around line 150)
- `src/agent/agent-loop.ts` — filter pinned-file `read_file` results from summarization input (lines 1260-1286)
- `examples/AGENTS.md` — add "State uncertainty" section (anti-confabulation rule)
- `skills/diet-tracker/SKILL.md` — add `pinned:` to frontmatter, bump version to 2.2.0, replace "read profile.md" instructions with references to `<pinned_skill_state>`
- `CLAUDE.md` — one-line mention in the `skills/` section
- `tests/unit/skill-loading.test.ts` — extend to cover `pinned` field parsing

---

## Task 1: Add `pinned` field to skill schema and loader

Foundation. No behaviour change yet — just plumbs the field through types + parser + tests.

**Files:**
- Modify: `src/skills/types.ts:1-17`
- Modify: `src/skills/skill-loader.ts:145-154`
- Test: `tests/unit/skill-loading.test.ts`

- [ ] **Step 1.1: Write failing test for `pinned` parsing**

Add to `tests/unit/skill-loading.test.ts` (use the existing `createSkillFile` helper pattern — extend its `opts` to accept `pinned`):

```ts
it('parses pinned field from frontmatter', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pinned-'));
  const skillDir = join(tmp, 'skills', 'demo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---
name: demo
description: test
version: 1.0.0
always: false
pinned:
  - profile.md
  - food-diary/{today}.md
---
body
`);
  const loader = new SkillLoader({ dirs: [join(tmp, 'skills')] });
  const skills = await loader.loadAll();
  expect(skills[0].pinned).toEqual(['profile.md', 'food-diary/{today}.md']);
  rmSync(tmp, { recursive: true, force: true });
});

it('treats missing pinned as empty array', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pinned-'));
  const skillDir = join(tmp, 'skills', 'demo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---
name: demo
description: test
version: 1.0.0
always: false
---
body
`);
  const loader = new SkillLoader({ dirs: [join(tmp, 'skills')] });
  const skills = await loader.loadAll();
  expect(skills[0].pinned).toEqual([]);
  rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 1.2: Run tests — should fail**

```bash
npx vitest run tests/unit/skill-loading.test.ts
```
Expected: both new tests fail (`pinned` is `undefined`).

- [ ] **Step 1.3: Add `pinned` field to `SkillDefinition`**

Edit `src/skills/types.ts`. After the `always: boolean;` line, add:

```ts
  /**
   * Files listed here are read from disk every LLM call and injected into the
   * system prompt — survives summarization. Supports {today}/{yesterday}/{userId}.
   * See docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md.
   */
  pinned: string[];
```

Final shape:
```ts
export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  requires?: { bins?: string[]; env?: string[]; };
  always: boolean;
  pinned: string[];
  complexity?: { simple?: TierConfig; medium?: TierConfig; complex?: TierConfig; };
  instructions: string;
  location: string;
}
```

- [ ] **Step 1.4: Parse `pinned` in skill loader**

Edit `src/skills/skill-loader.ts` line 150 area. Inside `parseSkillMd`, after the `always:` line, add `pinned`:

```ts
return {
  name: String(meta.name ?? 'unknown'),
  description: String(meta.description ?? ''),
  version: String(meta.version ?? '0.0.0'),
  requires: meta.requires as SkillDefinition['requires'],
  always: Boolean(meta.always ?? false),
  pinned: Array.isArray(meta.pinned) ? meta.pinned.map(String) : [],
  complexity: meta.complexity as SkillDefinition['complexity'],
  instructions: body.trim(),
  location: filePath,
};
```

- [ ] **Step 1.5: Run tests — should pass**

```bash
npx vitest run tests/unit/skill-loading.test.ts
```
Expected: both new tests PASS, existing tests still PASS.

- [ ] **Step 1.6: Typecheck**

```bash
npm run typecheck
```
Expected: no errors. If errors mention `pinned` not in `SkillDefinition`, double-check Step 1.3.

- [ ] **Step 1.7: Commit**

```bash
git add src/skills/types.ts src/skills/skill-loader.ts tests/unit/skill-loading.test.ts
git commit -m "feat(skills): parse pinned field from SKILL.md frontmatter"
```

---

## Task 2: Pinned-state module (pure, no integration)

Pure function that takes skills + context, returns the XML block + a set of resolved paths. No I/O integration yet.

**Files:**
- Create: `src/context/pinned-state.ts`
- Create: `tests/unit/pinned-state.test.ts`

- [ ] **Step 2.1: Write failing test — template substitution**

Create `tests/unit/pinned-state.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPinnedStateSection } from '../../src/context/pinned-state.js';
import type { SkillDefinition } from '../../src/skills/types.js';

const skill = (name: string, pinned: string[]): SkillDefinition => ({
  name,
  description: '',
  version: '1.0.0',
  always: false,
  pinned,
  instructions: '',
  location: '/fake',
});

describe('buildPinnedStateSection', () => {
  let workspaceDir: string;
  let userFilesDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'pinned-'));
    userFilesDir = join(workspaceDir, '.janus', 'users', 'u1', 'files');
    mkdirSync(userFilesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('returns null when no skills have pinned files', async () => {
    const result = await buildPinnedStateSection({
      skills: [skill('a', []), skill('b', [])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result).toBeNull();
  });

  it('renders file content when file exists', async () => {
    writeFileSync(join(userFilesDir, 'profile.md'), 'TARGET: 75kg\n');
    const result = await buildPinnedStateSection({
      skills: [skill('diet-tracker', ['profile.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result).not.toBeNull();
    expect(result!.xml).toContain('<pinned_skill_state>');
    expect(result!.xml).toContain('skill="diet-tracker"');
    expect(result!.xml).toContain('path="profile.md"');
    expect(result!.xml).toContain('TARGET: 75kg');
    expect(result!.pinnedPaths.has(join(userFilesDir, 'profile.md'))).toBe(true);
  });

  it('substitutes {today} in path', async () => {
    mkdirSync(join(userFilesDir, 'food-diary'));
    writeFileSync(join(userFilesDir, 'food-diary', '2026-05-14.md'), 'breakfast: eggs\n');
    const result = await buildPinnedStateSection({
      skills: [skill('diet-tracker', ['food-diary/{today}.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result!.xml).toContain('path="food-diary/2026-05-14.md"');
    expect(result!.xml).toContain('breakfast: eggs');
  });

  it('renders placeholder for missing file', async () => {
    const result = await buildPinnedStateSection({
      skills: [skill('diet-tracker', ['food-diary/{today}.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result!.xml).toContain('status="missing"');
    expect(result!.xml).toContain('file does not exist yet');
    // missing paths still tracked so summarization can ignore future reads of them
    expect(result!.pinnedPaths.size).toBe(1);
  });

  it('substitutes {userId}', async () => {
    mkdirSync(join(userFilesDir, 'data'), { recursive: true });
    writeFileSync(join(userFilesDir, 'data', 'u1.json'), '{}\n');
    const result = await buildPinnedStateSection({
      skills: [skill('demo', ['data/{userId}.json'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result!.xml).toContain('path="data/u1.json"');
  });

  it('concatenates files across multiple skills', async () => {
    writeFileSync(join(userFilesDir, 'a.md'), 'AAA');
    writeFileSync(join(userFilesDir, 'b.md'), 'BBB');
    const result = await buildPinnedStateSection({
      skills: [skill('one', ['a.md']), skill('two', ['b.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result!.xml).toContain('AAA');
    expect(result!.xml).toContain('BBB');
    expect(result!.xml).toContain('skill="one"');
    expect(result!.xml).toContain('skill="two"');
  });

  it('blocks path escape via ..', async () => {
    writeFileSync(join(workspaceDir, 'outside.md'), 'leaked');
    const result = await buildPinnedStateSection({
      skills: [skill('bad', ['../../outside.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    // path escape silently skipped; nothing leaked
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2.2: Run tests — should fail**

```bash
npx vitest run tests/unit/pinned-state.test.ts
```
Expected: all tests fail with "Cannot find module".

- [ ] **Step 2.3: Implement `pinned-state.ts`**

Create `src/context/pinned-state.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import type { SkillDefinition } from '../skills/types.js';
import { log } from '../utils/logger.js';

export interface BuildPinnedStateInput {
  skills: SkillDefinition[];
  workspaceDir: string;
  userId: string;
  today: string;     // YYYY-MM-DD
  yesterday: string; // YYYY-MM-DD
}

export interface BuildPinnedStateResult {
  xml: string;
  pinnedPaths: Set<string>; // absolute paths — for summarization filter
}

// Pinned files bypass summarization and live in system prompt to survive
// context compaction. See docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md.
export async function buildPinnedStateSection(
  input: BuildPinnedStateInput,
): Promise<BuildPinnedStateResult | null> {
  const skillsWithPinned = input.skills.filter(s => s.pinned && s.pinned.length > 0);
  if (skillsWithPinned.length === 0) return null;

  const userFilesRoot = resolve(input.workspaceDir, '.janus', 'users', input.userId, 'files');
  const fileBlocks: string[] = [];
  const pinnedPaths = new Set<string>();
  let totalChars = 0;

  for (const skill of skillsWithPinned) {
    for (const rawPath of skill.pinned) {
      const resolvedRelPath = substituteTemplates(rawPath, input);
      const absPath = resolve(userFilesRoot, resolvedRelPath);

      // Path-escape guard: absPath must stay under userFilesRoot
      const rel = relative(userFilesRoot, absPath);
      if (rel.startsWith('..') || rel === '' || rel.startsWith(`..${sep}`)) {
        log.warn(`[pinned] ${skill.name}: path escape blocked: ${rawPath}`);
        continue;
      }

      pinnedPaths.add(absPath);

      try {
        const content = await readFile(absPath, 'utf-8');
        totalChars += content.length;
        fileBlocks.push(
          `<file path="${resolvedRelPath}" skill="${skill.name}">\n${content}\n</file>`,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          fileBlocks.push(
            `<file path="${resolvedRelPath}" skill="${skill.name}" status="missing">\n` +
            `(file does not exist yet — will be created on first entry)\n</file>`,
          );
        } else {
          log.warn(`[pinned] ${skill.name}: read failed for ${resolvedRelPath}: ${(err as Error).message}`);
        }
      }
    }
  }

  if (fileBlocks.length === 0) return null;

  const tokens = Math.ceil(totalChars / 2.5);
  log.info(`[pinned] ${skillsWithPinned.length} skill(s), ${fileBlocks.length} file(s), ~${tokens} tokens`);

  return {
    xml: `<pinned_skill_state>\n${fileBlocks.join('\n\n')}\n</pinned_skill_state>`,
    pinnedPaths,
  };
}

function substituteTemplates(path: string, ctx: BuildPinnedStateInput): string {
  return path
    .replaceAll('{today}', ctx.today)
    .replaceAll('{yesterday}', ctx.yesterday)
    .replaceAll('{userId}', ctx.userId);
}
```

- [ ] **Step 2.4: Run tests — should pass**

```bash
npx vitest run tests/unit/pinned-state.test.ts
```
Expected: all 7 tests PASS.

- [ ] **Step 2.5: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 2.6: Commit**

```bash
git add src/context/pinned-state.ts tests/unit/pinned-state.test.ts
git commit -m "feat(context): pinned skill state module with template substitution"
```

---

## Task 3: Integrate pinned section into context-builder with channel-aware activation

Wire `buildPinnedStateSection` into `ContextBuilder.build()`. A skill's pinned files are loaded when:
- The skill's `skill-channels.json` entry matches the current `(channel, chatId)`, OR
- The skill has `always: true` (always-on skills).

**Files:**
- Modify: `src/context/context-builder.ts:130-189`
- Test: extend `tests/unit/pinned-state.test.ts` with an activation-filter test

- [ ] **Step 3.1: Write failing test for activation filter**

This is a small helper — write it as a unit test in `tests/unit/pinned-state.test.ts`:

```ts
import { isSkillActiveForChat } from '../../src/context/pinned-state.js';

describe('isSkillActiveForChat', () => {
  const skillBase = (name: string, always = false): SkillDefinition => ({
    name, description: '', version: '1.0.0', always, pinned: ['x'],
    instructions: '', location: '/fake',
  });

  it('returns true for always:true skill regardless of channel', () => {
    expect(isSkillActiveForChat(skillBase('a', true), 'telegram', '123', {})).toBe(true);
  });

  it('returns true when skill-channels matches current chat', () => {
    const prefs = { 'diet-tracker': { channel: 'telegram', chatId: '-100', chatName: 'd', setAt: '' } };
    expect(isSkillActiveForChat(skillBase('diet-tracker'), 'telegram', '-100', prefs)).toBe(true);
  });

  it('returns false when skill-channels chatId differs', () => {
    const prefs = { 'diet-tracker': { channel: 'telegram', chatId: '-100', chatName: 'd', setAt: '' } };
    expect(isSkillActiveForChat(skillBase('diet-tracker'), 'telegram', '-200', prefs)).toBe(false);
  });

  it('returns false when no preference and not always', () => {
    expect(isSkillActiveForChat(skillBase('diet-tracker'), 'telegram', '-100', {})).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run test — should fail**

```bash
npx vitest run tests/unit/pinned-state.test.ts -t isSkillActiveForChat
```
Expected: "Cannot find isSkillActiveForChat".

- [ ] **Step 3.3: Add `isSkillActiveForChat` helper**

Append to `src/context/pinned-state.ts`:

```ts
export interface SkillChannelPref {
  channel: string;
  chatId: string;
  chatName: string;
  setAt: string;
}

export function isSkillActiveForChat(
  skill: SkillDefinition,
  channel: string,
  chatId: string,
  prefs: Record<string, SkillChannelPref>,
): boolean {
  if (skill.always) return true;
  const pref = prefs[skill.name];
  if (!pref) return false;
  return pref.channel === channel && pref.chatId === chatId;
}
```

- [ ] **Step 3.4: Run test — should pass**

```bash
npx vitest run tests/unit/pinned-state.test.ts
```
Expected: all tests PASS.

- [ ] **Step 3.5: Find `loadSkillChannels` import path**

```bash
grep -n "loadSkillChannels\|skill-channels" /Users/wt/Sites/janus-agent/src/context/context-builder.ts | head -5
```
Note: line 220-234 already uses `loadSkillChannels`. We will reuse the import.

- [ ] **Step 3.6: Wire pinned section into `context-builder.ts`**

In `src/context/context-builder.ts`, after the skill-channels block (around line 151, just before the `if (!minimal && !background)` block), add:

```ts
    // Pinned skill state — survives summarization. Loaded fresh each call.
    // See docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md.
    let pinnedPathsForSummary: Set<string> | undefined;
    if (opts.user?.userId) {
      const allSkills = await this.deps.skills.loadAll();
      const skillPrefs = await loadSkillChannels(opts.user.userId, this.deps.config.workspace.dir);
      const activeSkills = allSkills.filter(s =>
        isSkillActiveForChat(s, opts.channel, opts.chatId, skillPrefs as Record<string, SkillChannelPref>),
      );
      const pinned = await buildPinnedStateSection({
        skills: activeSkills,
        workspaceDir: this.deps.config.workspace.dir,
        userId: opts.user.userId,
        today: localDate(),
        yesterday: localDate(new Date(Date.now() - 86_400_000)),
      });
      if (pinned) {
        dynamicParts.push(pinned.xml);
        pinnedPathsForSummary = pinned.pinnedPaths;
      }
    }
```

Add imports at top of file:

```ts
import { buildPinnedStateSection, isSkillActiveForChat, type SkillChannelPref } from './pinned-state.js';
import { localDate } from '../utils/date.js';
```

(`localDate` may already be imported — check; if so, don't duplicate.)

- [ ] **Step 3.7: Return `pinnedPaths` from `build()` for use by summarization**

Find the return signature of `ContextBuilder.build()`. It returns `{ staticPart, dynamicPart }`. Extend to optionally return `pinnedPaths`:

```ts
return {
  staticPart: staticParts.join('\n\n---\n\n'),
  dynamicPart: dynamicParts.join('\n\n---\n\n'),
  pinnedPaths: pinnedPathsForSummary,
};
```

Update the return type interface in the same file (search for the type that captures `staticPart`/`dynamicPart` — it may be inline or a separate `BuildResult` type). Add `pinnedPaths?: Set<string>`.

- [ ] **Step 3.8: Typecheck**

```bash
npm run typecheck
```
Fix any errors before continuing. Common ones: missing import, return type mismatch in callers of `build()`.

- [ ] **Step 3.9: Run full test suite**

```bash
npm test
```
Expected: existing tests still PASS. (No new integration test yet — that comes in the smoke test task.)

- [ ] **Step 3.10: Commit**

```bash
git add src/context/context-builder.ts src/context/pinned-state.ts tests/unit/pinned-state.test.ts
git commit -m "feat(context): inject pinned skill state into system prompt"
```

---

## Task 4: Exclude pinned-file reads from summarization input

When the agent reads a pinned file via `read_file`, the resulting `tool` message should NOT be included in the summarization input (the file content is already injected fresh every call).

**Files:**
- Modify: `src/agent/agent-loop.ts:1260-1286` (and call sites of context-builder that pass `pinnedPaths` through)
- Test: `tests/unit/agent-loop.test.ts` (or create new) — verify filter behavior

- [ ] **Step 4.1: Write failing test for the filter**

Create or extend `tests/unit/agent-loop-pinned-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterPinnedReadsFromSummarization } from '../../src/agent/agent-loop.js';
import type { LLMMessage } from '../../src/llm/types.js';

describe('filterPinnedReadsFromSummarization', () => {
  const pinned = new Set<string>(['/abs/path/profile.md']);

  it('drops tool result of read_file targeting a pinned path', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: '/abs/path/profile.md' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'TARGET: 75kg' },
      { role: 'assistant', content: 'OK', tool_calls: [] },
    ];
    const filtered = filterPinnedReadsFromSummarization(messages, pinned);
    expect(filtered.find(m => m.role === 'tool' && m.tool_call_id === 'call_1')).toBeUndefined();
  });

  it('keeps tool result of read_file targeting a non-pinned path', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: '/abs/path/other.md' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'other content' },
    ];
    const filtered = filterPinnedReadsFromSummarization(messages, pinned);
    expect(filtered.find(m => m.role === 'tool' && m.tool_call_id === 'call_2')).toBeDefined();
  });

  it('keeps tool results from non-read_file calls regardless of path', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_3',
          type: 'function',
          function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://x' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_3', content: 'page' },
    ];
    const filtered = filterPinnedReadsFromSummarization(messages, new Set());
    expect(filtered.find(m => m.role === 'tool' && m.tool_call_id === 'call_3')).toBeDefined();
  });

  it('returns input unchanged when pinned set is empty', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'x' },
      { role: 'tool', tool_call_id: 'c1', content: 'y' },
    ];
    expect(filterPinnedReadsFromSummarization(messages, new Set())).toEqual(messages);
  });
});
```

- [ ] **Step 4.2: Run test — should fail**

```bash
npx vitest run tests/unit/agent-loop-pinned-filter.test.ts
```
Expected: "Cannot find filterPinnedReadsFromSummarization".

- [ ] **Step 4.3: Export the filter function from `agent-loop.ts`**

Add to `src/agent/agent-loop.ts` (export it near the top of the file, after imports):

```ts
import { resolve } from 'node:path';
import type { LLMMessage, ToolCall } from '../llm/types.js';

// Pinned-file tool_results are dropped from summarization: their content is
// re-injected fresh on every call, so summarizing a stale snapshot adds nothing
// and dilutes the narrative budget.
// See docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md.
export function filterPinnedReadsFromSummarization(
  messages: LLMMessage[],
  pinnedPaths: Set<string>,
): LLMMessage[] {
  if (pinnedPaths.size === 0) return messages;

  // Pass 1: collect tool_call_ids of read_file calls targeting a pinned path
  const dropIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const tcs = (m as { tool_calls?: ToolCall[] }).tool_calls;
    if (!tcs?.length) continue;
    for (const tc of tcs) {
      if (tc.function.name !== 'read_file') continue;
      try {
        const args = JSON.parse(tc.function.arguments) as { path?: string };
        if (!args.path) continue;
        const abs = resolve(args.path);
        if (pinnedPaths.has(abs)) dropIds.add(tc.id);
      } catch { /* malformed args — keep */ }
    }
  }

  if (dropIds.size === 0) return messages;

  // Pass 2: filter out tool messages whose tool_call_id was marked
  return messages.filter(m => !(m.role === 'tool' && dropIds.has((m as { tool_call_id: string }).tool_call_id)));
}
```

- [ ] **Step 4.4: Run test — should pass**

```bash
npx vitest run tests/unit/agent-loop-pinned-filter.test.ts
```
Expected: all 4 tests PASS.

- [ ] **Step 4.5: Wire the filter into `doSummarization`**

In `src/agent/agent-loop.ts`, at line 1238 (just after `const toSummarize = messages.slice(0, cutIndex);`), insert:

```ts
    // Drop pinned-file reads from summarization input — they live in system prompt
    // and re-load fresh every call.
    const pinnedPaths = this.lastPinnedPaths ?? new Set<string>();
    const filteredForSummary = filterPinnedReadsFromSummarization(toSummarize, pinnedPaths);
```

Then change line 1264 from `toSummarize.map(m => {` to `filteredForSummary.map(m => {`.

- [ ] **Step 4.6: Track `lastPinnedPaths` on the agent loop instance**

Add to the `AgentLoop` class (find the class declaration near top of `agent-loop.ts`, look for `private summarizing` or similar instance state):

```ts
private lastPinnedPaths: Set<string> | undefined;
```

In the main `processMessage` function, after the `context = await contextBuilder.build(...)` call (search for `await this.deps.context.build` or similar — the call that produces `staticPart`/`dynamicPart`), capture:

```ts
this.lastPinnedPaths = context.pinnedPaths;
```

- [ ] **Step 4.7: Typecheck + run full tests**

```bash
npm run typecheck && npm test
```
Expected: all pass. If a test fails complaining about `context.pinnedPaths` being undefined on a mocked `ContextBuilder`, update the mock (search `tests/integration` for mocks of `build()`).

- [ ] **Step 4.8: Commit**

```bash
git add src/agent/agent-loop.ts tests/unit/agent-loop-pinned-filter.test.ts
git commit -m "feat(summary): exclude pinned-file reads from summarization input"
```

---

## Task 5: Update diet-tracker skill — proof of concept

Use diet-tracker as the first skill to declare `pinned:`. Bump version. Update mandatory sequences to reference `<pinned_skill_state>`.

**Files:**
- Modify: `skills/diet-tracker/SKILL.md`

- [ ] **Step 5.1: Update frontmatter**

Edit `skills/diet-tracker/SKILL.md` lines 1-6 to:

```yaml
---
name: diet-tracker
description: "Diet tracking — logging meals, calories/macros, weigh-ins, daily summaries, weekly reports. Use when user mentions food, weight, calories, macros, diet, or asks about their food diary."
version: "2.2.0"
always: false
pinned:
  - profile.md
  - food-diary/{today}.md
---
```

- [ ] **Step 5.2: Replace mandatory-read instructions**

Find the section "Logging a Meal" (around line 115). Replace this block:

```
After every "I ate X" — mandatory sequence:

1. Read `profile.md` (targets, fixed units, day types)
2. Read/create today's file `food-diary/YYYY-MM-DD.md`
```

With:

```
After every "I ate X" — mandatory sequence:

1. Read `<pinned_skill_state>` — `profile.md` and today's `food-diary/{today}.md` are
   already in your context, fresh. Do not call `read_file` for them unless they show
   `status="missing"` (in which case create today's file first).
2. If today's file is `status="missing"`, create it with the daily file format below
```

- [ ] **Step 5.3: Add state-uncertainty section to SKILL.md rules**

Find the "## Rules" section. Append a new bullet:

```
- **State uncertainty.** If the data you need is unclear, missing from `<pinned_skill_state>`,
  or contradicts what you remember: ask the user for clarification. NEVER explain
  confusion in terms of memory, sessions, summarization, or other Janus internals.
  The user does not need to know how Janus works — they need an answer or a question.
```

- [ ] **Step 5.4: Sanity-check the file**

```bash
head -15 /Users/wt/Sites/janus-agent/skills/diet-tracker/SKILL.md
```
Expected: new frontmatter visible, `pinned:` keys present.

- [ ] **Step 5.5: Commit**

```bash
git add skills/diet-tracker/SKILL.md
git commit -m "feat(diet-tracker): declare pinned files, bump to 2.2.0"
```

---

## Task 6: Add anti-confabulation rule to AGENTS.md template

Global rule for all chats: when state is uncertain, read source-of-truth or ask. Never confabulate.

**Files:**
- Modify: `examples/AGENTS.md`

- [ ] **Step 6.1: Locate insertion point**

```bash
cat /Users/wt/Sites/janus-agent/examples/AGENTS.md | head -50
```
Identify the right spot to add a new section (after existing general rules, before skill-specific rules if any).

- [ ] **Step 6.2: Add "State uncertainty" section**

Append to `examples/AGENTS.md`:

```markdown

## State uncertainty

When the requested data is unclear, missing, or contradicts what you remember:

1. First, check `<pinned_skill_state>` — if the relevant file is there with content,
   use it as the source of truth.
2. If the file shows `status="missing"`, call the appropriate tool (`read_file`, `list_dir`)
   to verify, or ask the user.
3. If none of the above answers the question, ASK the user for what you need.
4. NEVER explain confusion in terms of memory limits, session boundaries, agent instances,
   summarization, or any other Janus internal. The user does not need to know how Janus works
   — they need an answer or a question.
```

- [ ] **Step 6.3: Commit**

```bash
git add examples/AGENTS.md
git commit -m "docs(agents): anti-confabulation rule for state uncertainty"
```

---

## Task 7: CLAUDE.md one-line update

Brief mention so future contributors know the mechanism exists.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 7.1: Find the skills entry**

```bash
grep -n "skills/" /Users/wt/Sites/janus-agent/CLAUDE.md | head -5
```

- [ ] **Step 7.2: Add one-liner**

In the `### Key modules (src/)` section, on the `skills/` line, append:

```
+ pinned skill state (skills declare `pinned: [file, ...]` in frontmatter — files survive summarization, see docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md)
```

- [ ] **Step 7.3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: mention pinned skill state in CLAUDE.md"
```

---

## Task 8: Final verification and PR

End-to-end check that nothing regressed and the smoking gun scenario now works.

- [ ] **Step 8.1: Run full test suite**

```bash
npm test
```
Expected: 597+ tests PASS (we added ~12 new tests). No failures.

- [ ] **Step 8.2: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 8.3: Manual smoke test — pinned section in system prompt**

Add a temporary log statement OR run with `--token-debug`:

```bash
npm start -- --token-debug -m "test"
```
Verify in console output that the system prompt contains `<pinned_skill_state>` IF you have diet-tracker installed with channel preference set. (If you don't have channel preference set, expected behavior: no pinned section, this is correct.)

- [ ] **Step 8.4: Manual smoke test — confabulation suppression**

In the diet chat (or any chat where diet-tracker is the preferred channel):

1. Log a few meals
2. Send: "co dzisiaj jadłem?"
3. Expected: agent answers with food list from pinned `food-diary/{today}.md`, NOT with "nie mam dostępu do poprzednich wiadomości".

If the agent still confabulates: check the AGENTS.md change deployed to `~/.janus/AGENTS.md` (it may need `npm start -- onboard` to refresh).

- [ ] **Step 8.5: Push branch and open PR**

```bash
git push -u origin feat/pinned-skill-state-design
gh pr create --title "feat: pinned skill state (kill the recurring 'agent forgets' bumerang)" --body "$(cat <<'EOF'
## Summary

- Introduces `pinned: string[]` in SKILL.md frontmatter — files listed there are read fresh on every LLM call and injected into the system prompt as `<pinned_skill_state>`.
- Pinned-file `read_file` results are excluded from summarization input.
- Activation is channel-aware: a skill's pinned files load when the current chat matches its `skill-channels.json` entry, or unconditionally for `always: true` skills.
- diet-tracker is the proof-of-concept (bumped to 2.2.0).
- Anti-confabulation rule added to `examples/AGENTS.md`.

Spec: `docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md`.

## Why

Three prior fix waves (#187-189, #192-201, #203/204/207) addressed *how* summarization runs but not *what* it captures. Operational state in skill files kept getting compacted away. This PR splits the two memory paths so they stop overwriting each other.

## Test plan

- [ ] `npm test` — all tests pass (12 new unit tests)
- [ ] `npm run typecheck` — no errors
- [ ] Manual: log 5 meals in diet chat → ask "co dzisiaj jadłem?" → agent answers from pinned `food-diary/{today}.md`, no confabulation
- [ ] Manual: send a message in a non-diet chat → no `<pinned_skill_state>` block (verified via `--token-debug`)
- [ ] Manual: trigger summarization (long conversation) → after summary, ask about today's state again → still works
EOF
)"
```

- [ ] **Step 8.6: Wait for review**

PR opened. Wait for review and CI before merge. Per repo rules: squash and merge only, requires CI green + approval.

---

## Self-Review

After writing this plan, the spec was checked for coverage:

| Spec requirement | Implementing task(s) |
|---|---|
| Decision 1: frontmatter `pinned:` declaration | Task 1 |
| Decision 2: channel-aware activation | Task 3 (Step 3.3, 3.6) |
| Decision 3: refresh every LLM call | Task 2 + Task 3 (no caching layer added) |
| Decision 4: `{today}`/`{yesterday}`/`{userId}` templates | Task 2 (Step 2.3) |
| Decision 5: missing-file placeholder | Task 2 (Step 2.3, ENOENT branch) |
| Decision 6: no cap, observability log | Task 2 (Step 2.3, `[pinned]` log line) |
| Decision 7: exclude pinned from summarization | Task 4 |
| Decision 8: anti-confabulation rule | Task 6 (AGENTS.md) + Task 5 (diet-tracker SKILL.md) |
| Decision 9: per-user resolution (sender's userId) | Task 3 (Step 3.6 uses `opts.user.userId`) |
| Decision 10: position in system prompt | Task 3 (Step 3.6 — appended to `dynamicParts` after skill-channels) |
| Decision 11: tool-result interaction (no dedup) | Implicit — no code added; SKILL.md updated in Task 5 |
| Code comment plan (3 comments) | Task 2 (Step 2.3, top-of-function), Task 1 (Step 1.3, schema field), Task 4 (Step 4.3, filter function) |
| Troubleshooting runbook | Lives in spec doc; no code task needed |
| CLAUDE.md mention | Task 7 |

**Type consistency:** `pinned: string[]` (not `pinned?: string[]`) in `SkillDefinition` — parser always assigns `[]` if missing, so the field is never undefined at the type boundary. Confirmed across Task 1 (Step 1.3) and Task 2 (Step 2.3 uses `.length > 0`).

**Naming:** `buildPinnedStateSection`, `isSkillActiveForChat`, `filterPinnedReadsFromSummarization` — consistent across all task references.

No placeholders. No "TBD". No "similar to Task N" without code.
