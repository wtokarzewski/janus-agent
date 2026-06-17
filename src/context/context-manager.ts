import type { LLMMessage, UserContentBlock, ToolContentBlock } from '../llm/types.js';
import { safeSlice } from '../utils/sanitize.js';

// Single source of truth for context-management decisions.
// Replaces the 7-mechanism / 12-threshold system that accumulated 20+ patch PRs
// since 2026-04-01. See docs/superpowers/specs/2026-05-16-context-management-redesign.md.

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 4_000;
export const RESERVED_OUTPUT_TOKENS_DEFAULT = 8_000;
export const SAFETY_MARGIN = 1.2;
export const CHARS_PER_TOKEN_ESTIMATE = 2.5;
const TRUNCATE_ROUTE_BUFFER_TOKENS = 512;
const IMAGE_TOKEN_ESTIMATE = 2500;

// -----------------------------------------------------------------------------
// Budget resolution
// -----------------------------------------------------------------------------

export interface ContextBudget {
  /** Model's actual context window (e.g. 200_000 for Anthropic Sonnet). */
  contextWindow: number;
  /** Tokens reserved for the response. */
  reservedForOutput: number;
  /** Effective budget for prompt tokens = contextWindow - reservedForOutput. */
  effective: number;
  /** Source of contextWindow value (for diagnostics). */
  source: 'model' | 'config' | 'default';
}

export interface ResolveBudgetParams {
  modelContextWindow?: number;
  configOverride?: number;
  reservedForOutput?: number;
}

export function resolveBudget(params: ResolveBudgetParams): ContextBudget {
  let contextWindow: number;
  let source: ContextBudget['source'];
  if (params.configOverride && params.configOverride > 0) {
    contextWindow = params.configOverride;
    source = 'config';
  } else if (params.modelContextWindow && params.modelContextWindow > 0) {
    contextWindow = params.modelContextWindow;
    source = 'model';
  } else {
    contextWindow = 200_000;
    source = 'default';
  }
  const reservedForOutput = params.reservedForOutput ?? RESERVED_OUTPUT_TOKENS_DEFAULT;
  const effective = Math.max(CONTEXT_WINDOW_HARD_MIN_TOKENS, contextWindow - reservedForOutput);
  return { contextWindow, reservedForOutput, effective, source };
}

// -----------------------------------------------------------------------------
// Token estimation
// -----------------------------------------------------------------------------

function blockTextLength(blocks: readonly (UserContentBlock | ToolContentBlock)[]): number {
  let len = 0;
  for (const b of blocks) {
    if (b.type === 'text' && b.text) len += b.text.length;
    if (b.type === 'image') len += IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN_ESTIMATE; // convert tokens→chars for unified math
  }
  return len;
}

function messageContentLength(msg: LLMMessage): number {
  if (!('content' in msg)) return 0;
  const c = msg.content;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) return blockTextLength(c);
  return 0;
}

export function estimatePromptTokens(messages: LLMMessage[], systemPrompt: string): number {
  let chars = systemPrompt.length;
  for (const m of messages) chars += messageContentLength(m);
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

export function estimateMessagesTokens(messages: LLMMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += messageContentLength(m);
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

// -----------------------------------------------------------------------------
// Transform passes — soft trim + hard clear
// -----------------------------------------------------------------------------

export interface TransformSettings {
  /** Protect last N assistant turns (and their tool messages) from any trimming. */
  keepLastAssistants: number;
  softTrim: { maxChars: number; headChars: number; tailChars: number };
  hardClear: { enabled: boolean; placeholder: string };
}

export const DEFAULT_TRANSFORM_SETTINGS: TransformSettings = {
  keepLastAssistants: 3,
  softTrim: { maxChars: 4_000, headChars: 1_500, tailChars: 1_500 },
  hardClear: { enabled: true, placeholder: '[old tool result cleared to free context budget]' },
};

/**
 * Index of the oldest message in the "protected tail" — the last N assistant turns
 * plus any tool messages that follow them. Messages BEFORE this index are eligible
 * for trimming; messages AT or AFTER this index are never touched.
 *
 * Returns null if there aren't enough assistant turns to define a tail.
 */
function findProtectedTailStartIndex(messages: LLMMessage[], keepLastAssistants: number): number | null {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      seen++;
      if (seen >= keepLastAssistants) {
        return i;
      }
    }
  }
  return null;
}

function asString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .map(b => (b.type === 'text' && b.text ? b.text : ''))
      .join('');
  }
  return '';
}

export function softTrimOldToolResults(
  messages: LLMMessage[],
  settings: TransformSettings,
): LLMMessage[] {
  const cutoff = findProtectedTailStartIndex(messages, settings.keepLastAssistants);
  if (cutoff === null) return messages;

  let next: LLMMessage[] | null = null;
  const { maxChars, headChars, tailChars } = settings.softTrim;

  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const content = asString(m.content);
    if (content.length <= maxChars) continue;

    // safeSlice (not raw .slice) so we never split a UTF-16 surrogate pair —
    // an orphan surrogate makes the request body invalid JSON → provider 400.
    const head = safeSlice(content, 0, headChars);
    const tail = safeSlice(content, content.length - tailChars);
    const note = `\n\n[trimmed: kept first ${headChars} + last ${tailChars} of ${content.length} chars]\n\n`;
    const trimmed = head + note + tail;

    if (!next) next = messages.slice();
    next[i] = { ...m, content: trimmed };
  }

  return next ?? messages;
}

export function hardClearOldToolResults(
  messages: LLMMessage[],
  settings: TransformSettings,
): LLMMessage[] {
  if (!settings.hardClear.enabled) return messages;
  const cutoff = findProtectedTailStartIndex(messages, settings.keepLastAssistants);
  if (cutoff === null) return messages;

  let next: LLMMessage[] | null = null;
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    if (!next) next = messages.slice();
    next[i] = { ...m, content: settings.hardClear.placeholder };
  }

  return next ?? messages;
}

// -----------------------------------------------------------------------------
// Pre-call router
// -----------------------------------------------------------------------------

export type CallRoute =
  | { type: 'fits' }
  | { type: 'truncate_only' }
  | { type: 'compact_only' }
  | { type: 'compact_then_truncate' };

export interface RouterResult {
  route: CallRoute;
  estimatedTokens: number;
  budget: number;
  reducibleTokens: number;
  overflowTokens: number;
}

export function estimateReducibleToolTokens(
  messages: LLMMessage[],
  settings: TransformSettings,
): number {
  const cutoff = findProtectedTailStartIndex(messages, settings.keepLastAssistants);
  if (cutoff === null) return 0;

  let chars = 0;
  const trimmedSize = settings.softTrim.headChars + settings.softTrim.tailChars + 200; // est marker length

  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const content = asString(m.content);
    const reducible = Math.max(0, content.length - trimmedSize);
    chars += reducible;
  }

  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

export function routeCall(params: {
  messages: LLMMessage[];
  systemPrompt: string;
  budget: ContextBudget;
  transformSettings?: TransformSettings;
}): RouterResult {
  const settings = params.transformSettings ?? DEFAULT_TRANSFORM_SETTINGS;
  const raw = estimatePromptTokens(params.messages, params.systemPrompt);
  const estimated = Math.ceil(raw * SAFETY_MARGIN);
  const budget = params.budget.effective;
  const overflow = Math.max(0, estimated - budget);

  if (overflow === 0) {
    return {
      route: { type: 'fits' },
      estimatedTokens: estimated,
      budget,
      reducibleTokens: 0,
      overflowTokens: 0,
    };
  }

  const reducible = estimateReducibleToolTokens(params.messages, settings);
  if (reducible === 0) {
    return {
      route: { type: 'compact_only' },
      estimatedTokens: estimated,
      budget,
      reducibleTokens: 0,
      overflowTokens: overflow,
    };
  }
  const wouldFitByTruncate = reducible >= (overflow + TRUNCATE_ROUTE_BUFFER_TOKENS);
  if (wouldFitByTruncate) {
    return {
      route: { type: 'truncate_only' },
      estimatedTokens: estimated,
      budget,
      reducibleTokens: reducible,
      overflowTokens: overflow,
    };
  }
  return {
    route: { type: 'compact_then_truncate' },
    estimatedTokens: estimated,
    budget,
    reducibleTokens: reducible,
    overflowTokens: overflow,
  };
}
