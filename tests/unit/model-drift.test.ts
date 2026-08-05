import { describe, it, expect } from 'vitest';
import { findModelDrift } from '../../src/llm/model-drift.js';

describe('findModelDrift', () => {
  it('reports a configured model the provider no longer lists', () => {
    const drift = findModelDrift({
      provider: 'anthropic',
      configured: ['claude-sonnet-4-6'],
      available: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    });

    expect(drift).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-6', suggestion: 'claude-opus-5' },
    ]);
  });

  it('says nothing when every configured model is still served', () => {
    const drift = findModelDrift({
      provider: 'anthropic',
      configured: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
      available: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    });

    expect(drift).toEqual([]);
  });

  it('stays quiet when the list could not be fetched', () => {
    // An empty list means "we do not know", not "everything is gone".
    const drift = findModelDrift({
      provider: 'codex',
      configured: ['gpt-5.6-terra'],
      available: [],
    });

    expect(drift).toEqual([]);
  });

  it('ignores a provider-prefixed alias of a served model', () => {
    const drift = findModelDrift({
      provider: 'openrouter',
      configured: ['anthropic/claude-sonnet-5'],
      available: ['anthropic/claude-sonnet-5'],
    });

    expect(drift).toEqual([]);
  });

  it('reports each missing model once, keeping config order', () => {
    const drift = findModelDrift({
      provider: 'anthropic',
      configured: ['claude-opus-4-1-20250805', 'claude-sonnet-4-6', 'claude-opus-4-1-20250805'],
      available: ['claude-opus-5'],
    });

    expect(drift.map(d => d.model)).toEqual(['claude-opus-4-1-20250805', 'claude-sonnet-4-6']);
  });
});
