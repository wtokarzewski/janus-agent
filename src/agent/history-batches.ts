import type { ChatRequest, LLMMessage } from '../llm/types.js';
import { userContentText } from '../llm/types.js';
import { estimateRequestTokens } from '../context/context-manager.js';

/** Text-only serialization; image payloads must not become summary facts. */
export function historyText(message: LLMMessage): string {
  const content = userContentText(message.content);
  const omitted = Array.isArray(message.content) && message.content.some(block => block.type !== 'text');
  const text = `${message.role}: ${content}${omitted ? '\n[Non-text attachment omitted]' : ''}`;
  if (message.role === 'assistant' && message.tool_calls?.length) return `${text}\n[calls: ${JSON.stringify(message.tool_calls)}]`;
  if (message.role === 'tool') return `${text}\n[tool_call_id: ${JSON.stringify(message.tool_call_id)}]`;
  return text;
}

/** An assistant call and its results form one indivisible input unit. */
export function historyUnits(messages: LLMMessage[]): string[] {
  const units: string[] = [];
  for (const message of messages) {
    const text = historyText(message);
    if (message.role === 'tool' && units.length > 0) units[units.length - 1] += '\n' + text;
    else units.push(text);
  }
  return units;
}

/** Find the largest whole prefix that fits the complete request, not just its transcript. */
export function historyBatch(units: string[], start: number, build: (text: string) => ChatRequest, inputLimit: number): { text: string; end: number } {
  let lower = start;
  let upper = units.length;
  while (lower < upper) {
    const end = Math.ceil((lower + upper) / 2);
    const request = build(units.slice(start, end).join('\n'));
    if (estimateRequestTokens(request) <= inputLimit) lower = end;
    else upper = end - 1;
  }
  if (lower === start) throw new Error('A history unit or its context exceeds the available input budget');
  return { text: units.slice(start, lower).join('\n'), end: lower };
}
