import { describe, it, expect } from 'vitest';
import { stripControlTokens, stripOrphanSurrogates } from '../../src/utils/sanitize.js';

describe('stripControlTokens', () => {
  it('strips <|...|> tokens', () => {
    expect(stripControlTokens('Hello<|endoftext|> world')).toBe('Hello world');
    expect(stripControlTokens('<|im_start|>assistant\nHi<|im_end|>')).toBe('assistant\nHi');
    expect(stripControlTokens('text<|eot_id|>')).toBe('text');
  });

  it('strips [INST] and [/INST] tags', () => {
    expect(stripControlTokens('[INST] question [/INST] answer')).toBe('question  answer');
  });

  it('strips <<SYS>> and <</SYS>> tags', () => {
    expect(stripControlTokens('<<SYS>>system<</SYS>>response')).toBe('systemresponse');
  });

  it('strips <s> and </s> sentence markers', () => {
    expect(stripControlTokens('<s>Hello</s>')).toBe('Hello');
  });

  it('handles mixed tokens', () => {
    const dirty = '<|im_start|>assistant\n[INST]Hello<|endoftext|></s>';
    expect(stripControlTokens(dirty)).toBe('assistant\nHello');
  });

  it('leaves normal text unchanged', () => {
    expect(stripControlTokens('Hello, world!')).toBe('Hello, world!');
    expect(stripControlTokens('Use <div> tags')).toBe('Use <div> tags');
    expect(stripControlTokens('array[0]')).toBe('array[0]');
  });

  it('handles empty string', () => {
    expect(stripControlTokens('')).toBe('');
  });
});

describe('stripOrphanSurrogates', () => {
  it('removes orphan high surrogate', () => {
    // \uD800 without a following low surrogate
    const broken = 'hello\uD800world';
    expect(stripOrphanSurrogates(broken)).toBe('helloworld');
  });

  it('removes orphan low surrogate', () => {
    // \uDC00 without a preceding high surrogate
    const broken = 'hello\uDC00world';
    expect(stripOrphanSurrogates(broken)).toBe('helloworld');
  });

  it('preserves valid surrogate pairs (emoji)', () => {
    const emoji = '🚀🎉👍'; // valid surrogate pairs
    expect(stripOrphanSurrogates(emoji)).toBe(emoji);
  });

  it('removes orphan created by string slice between surrogate pair', () => {
    const emoji = '🚀'; // \uD83D\uDE80
    const sliced = emoji.slice(0, 1); // orphan high surrogate \uD83D
    expect(sliced.length).toBe(1);
    expect(stripOrphanSurrogates(sliced)).toBe('');
  });

  it('handles mixed valid and orphan surrogates', () => {
    const text = 'before🚀\uD800after\uDC00end';
    expect(stripOrphanSurrogates(text)).toBe('before🚀afterend');
  });

  it('leaves normal text unchanged', () => {
    expect(stripOrphanSurrogates('Hello, world!')).toBe('Hello, world!');
    expect(stripOrphanSurrogates('')).toBe('');
  });

  it('result is safe for JSON.stringify', () => {
    const broken = 'data\uD800\uD83D\uDE80more\uDC00end';
    const clean = stripOrphanSurrogates(broken);
    expect(() => JSON.stringify(clean)).not.toThrow();
  });
});
