import { describe, it, expect } from 'vitest';
import { stripControlTokens } from '../../src/utils/sanitize.js';

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
