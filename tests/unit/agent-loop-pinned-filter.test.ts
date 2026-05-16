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
