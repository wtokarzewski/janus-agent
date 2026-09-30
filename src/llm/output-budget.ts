import type { ChatRequest } from './types.js';

const DEFAULT_OUTPUT_TOKENS = 4_096;
const MIN_THINKING_TOKENS = 1_024;
const MIN_OUTPUT_TOKENS = 1_024;

/** See THIRD_PARTY_NOTICES.md for the source and license of the budget algorithm. */
export function resolveThinkingBudget(request: Pick<ChatRequest, 'maxTokens' | 'modelMaxTokens' | 'thinking'>): {
  maxTokens: number; thinkingBudget?: number;
} {
  const base = request.maxTokens ?? DEFAULT_OUTPUT_TOKENS;
  const cap = request.modelMaxTokens ?? Number.POSITIVE_INFINITY;
  let thinkingBudget = request.thinking?.budgetTokens ?? 0;
  if (thinkingBudget < MIN_THINKING_TOKENS) return { maxTokens: Math.min(base, cap) };
  const maxTokens = Math.min(base + thinkingBudget, cap);
  if (maxTokens <= thinkingBudget) thinkingBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
  if (thinkingBudget < MIN_THINKING_TOKENS) return { maxTokens: Math.min(base, cap) };
  return { maxTokens, thinkingBudget };
}
