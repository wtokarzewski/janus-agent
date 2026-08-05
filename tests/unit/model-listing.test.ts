import { describe, it, expect } from 'vitest';
import { keepLatestPerFamily } from '../../src/llm/model-listing.js';

const ids = (models: { id: string }[]) => models.map(m => m.id);
const list = (...items: string[]) => items.map(id => ({ id, name: id }));

describe('keepLatestPerFamily', () => {
  it('keeps one entry per model family — the highest version', () => {
    // Verbatim shape of an Anthropic /v1/models response for a live account.
    const fetched = list(
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-1-20250805',
    );

    expect(ids(keepLatestPerFamily(fetched))).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('keeps every sibling that shares the newest version', () => {
    // Sol / Terra / Luna are one generation — none of them is "older".
    const fetched = list('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini');

    expect(ids(keepLatestPerFamily(fetched))).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  });

  it('preserves the order the provider returned', () => {
    const fetched = list('claude-sonnet-5', 'claude-opus-5');
    expect(ids(keepLatestPerFamily(fetched))).toEqual(['claude-sonnet-5', 'claude-opus-5']);
  });

  it('treats a trailing date as a snapshot, not a version bump', () => {
    const fetched = list('claude-haiku-4-5-20251001', 'claude-haiku-4-5');
    expect(ids(keepLatestPerFamily(fetched))).toHaveLength(1);
  });

  it('leaves unversioned IDs alone', () => {
    const fetched = list('deepseek-chat', 'deepseek-reasoner');
    expect(ids(keepLatestPerFamily(fetched))).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('handles an empty list', () => {
    expect(keepLatestPerFamily([])).toEqual([]);
  });
});
