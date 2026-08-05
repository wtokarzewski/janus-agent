import { describe, it, expect } from 'vitest';
import { modelRejectsSamplingParams } from '../../src/llm/anthropic-provider.js';
import { resolveModel } from '../../src/llm/claude-agent-provider.js';

describe('modelRejectsSamplingParams', () => {
  // These models return 400 when temperature/top_p/top_k are present.
  it.each([
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5',
    'claude-fable-5',
  ])('omits sampling params for %s', (model) => {
    expect(modelRejectsSamplingParams(model)).toBe(true);
  });

  it('keeps sampling params for models that still accept them', () => {
    expect(modelRejectsSamplingParams('claude-sonnet-4-6')).toBe(false);
    expect(modelRejectsSamplingParams('claude-haiku-4-5-20251001')).toBe(false);
  });

  it('strips a provider prefix before matching', () => {
    expect(modelRejectsSamplingParams('anthropic/claude-opus-5')).toBe(true);
  });
});

describe('claude-agent model aliases', () => {
  it('points the bare aliases at the current generation', () => {
    expect(resolveModel('opus')).toBe('claude-opus-5');
    expect(resolveModel('sonnet')).toBe('claude-sonnet-5');
    expect(resolveModel('fable')).toBe('claude-fable-5');
  });

  it('keeps pinned aliases for older releases', () => {
    expect(resolveModel('opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveModel('opus-4-7')).toBe('claude-opus-4-7');
  });

  it('passes a full model ID through untouched', () => {
    expect(resolveModel('claude-opus-4-6')).toBe('claude-opus-4-6');
  });
});
