/**
 * Graduated context compaction: soft-trim → hard-clear → drop turns.
 * Replaces the old trimHistoryToTokenBudget + pruneOldToolResults functions.
 */

import type { LLMMessage, ToolContentBlock } from '../llm/types.js';
import * as log from '../utils/logger.js';
import { safeSlice } from '../utils/sanitize.js';

export interface ContextBudgetConfig {
  tokenBudget: number;
  context: {
    softTrimChars: number;
    compactionThresholds: [number, number, number];
    emergencyThreshold: number;
    protectedTailTurns: number;
  };
}

// ---------------------------------------------------------------------------
// Token estimation (mirrors agent-loop.ts heuristic)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function estimateMessageTokens(msg: LLMMessage): number {
  let total = 0;
  if ('content' in msg && msg.content) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content as ToolContentBlock[]) {
        if (b.type === 'text') total += estimateTokens(b.text);
        else if (b.type === 'image') total += 1000;
      }
    }
  }
  if ('tool_calls' in msg && msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTokens(tc.function.name + tc.function.arguments);
    }
  }
  return total;
}

function estimateTotal(messages: LLMMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ---------------------------------------------------------------------------
// Annotation extraction for hard-cleared tool results
// ---------------------------------------------------------------------------

function extractAnnotation(msg: LLMMessage): string {
  if (msg.role !== 'tool' || typeof msg.content !== 'string') return '';
  const content = msg.content;
  const firstLine = content.split('\n')[0]?.slice(0, 120) ?? '';
  return firstLine.replace(/\n/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Enforce the context token budget via graduated in-place compaction:
 *   Phase 1 (≥75%) — soft-trim long tool results (head+tail with [trimmed])
 *   Phase 2 (≥80%) — hard-clear tool results → "[tool result cleared]"
 *   Phase 3 (≥85%) — drop oldest assistant+tool turn groups (never user msgs)
 *
 * In emergency mode the protected tail is disabled so every non-user message
 * outside the system prefix can be compacted.
 */
export function enforceContextBudget(
  messages: LLMMessage[],
  config: ContextBudgetConfig,
  emergency = false,
): void {
  const { tokenBudget, context } = config;
  const [t1, t2, t3] = context.compactionThresholds;

  let tokens = estimateTotal(messages);
  if (tokens <= t1 * tokenBudget) return;

  // --- Locate immutable boundaries ---

  // First user message index — everything before it (system/bootstrap) is untouchable.
  let firstUserIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') { firstUserIndex = i; break; }
  }

  // Protected tail — walk backwards counting assistant messages.
  let tailStart = messages.length;
  if (!emergency && context.protectedTailTurns > 0) {
    let assistantsSeen = 0;
    for (let i = messages.length - 1; i >= firstUserIndex; i--) {
      if (messages[i].role === 'assistant') {
        assistantsSeen++;
        if (assistantsSeen >= context.protectedTailTurns) {
          tailStart = i;
          break;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Phase 1 — Soft-trim (trigger: >t1 budget)
  // -----------------------------------------------------------------------
  if (tokens > t1 * tokenBudget) {
    log.info(`[context-budget] Phase 1: soft-trim (${tokens}/${tokenBudget} tokens, ${Math.round(tokens / tokenBudget * 100)}%)`);
    const halfTrim = Math.floor(context.softTrimChars * 0.375);

    for (let i = tailStart - 1; i >= firstUserIndex && tokens > t1 * tokenBudget; i--) {
      const msg = messages[i];
      if (msg.role !== 'tool') continue;
      if (typeof msg.content !== 'string') continue;
      if (msg.content.length <= context.softTrimChars) continue;

      const before = estimateTokens(msg.content);
      const head = safeSlice(msg.content, 0, halfTrim);
      const tail = safeSlice(msg.content, msg.content.length - halfTrim);
      (msg as { content: string }).content = head + '\n[trimmed]\n' + tail;
      const after = estimateTokens(msg.content);
      tokens -= (before - after);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2 — Hard-clear (trigger: >t2 budget)
  // -----------------------------------------------------------------------
  if (tokens > t2 * tokenBudget) {
    log.info(`[context-budget] Phase 2: hard-clear (${tokens}/${tokenBudget} tokens, ${Math.round(tokens / tokenBudget * 100)}%)`);

    for (let i = tailStart - 1; i >= firstUserIndex && tokens > t2 * tokenBudget; i--) {
      const msg = messages[i];
      if (msg.role !== 'tool') continue;
      if (typeof msg.content !== 'string') continue;

      const before = estimateTokens(msg.content);
      const annotation = extractAnnotation(msg);
      const replacement = annotation ? `[cleared — ${annotation}]` : '[tool result cleared]';
      (msg as { content: string }).content = replacement;
      const after = estimateTokens(replacement);
      tokens -= (before - after);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 3 — Drop turns (trigger: >t3 budget)
  // -----------------------------------------------------------------------
  if (tokens > t3 * tokenBudget) {
    log.info(`[context-budget] Phase 3: drop turns (${tokens}/${tokenBudget} tokens, ${Math.round(tokens / tokenBudget * 100)}%)`);

    // Count non-system messages to enforce the floor of 2.
    const nonSystemCount = () => messages.filter(m => m.role !== 'system').length;

    // Scan forward from firstUserIndex, find the oldest assistant, drop it + following tool msgs.
    while (tokens > t3 * tokenBudget && nonSystemCount() > 2) {
      // Find oldest assistant message in the droppable range.
      let idx = -1;
      for (let i = firstUserIndex; i < messages.length; i++) {
        if (messages[i].role === 'assistant') { idx = i; break; }
      }
      if (idx === -1) break; // no more assistant messages to drop

      // Count how many messages to remove (assistant + immediately following tool messages).
      let count = 1;
      while (idx + count < messages.length && messages[idx + count].role === 'tool') {
        count++;
      }

      // Subtract tokens for the group.
      for (let j = idx; j < idx + count; j++) {
        tokens -= estimateMessageTokens(messages[j]);
      }

      messages.splice(idx, count);
    }
  }
}
