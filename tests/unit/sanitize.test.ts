import { describe, it, expect } from 'vitest';
import { stripControlTokens, stripOrphanSurrogates, stripJsonSurrogates } from '../../src/utils/sanitize.js';

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

describe('stripJsonSurrogates', () => {
  it('strips JSON-encoded orphan high surrogate', () => {
    // As stored in JSONL: literal \uD800 (6 ASCII chars, not actual surrogate)
    const json = '{"content":"hello\\uD800world"}';
    const clean = stripJsonSurrogates(json);
    expect(clean).toBe('{"content":"helloworld"}');
    expect(() => JSON.parse(clean)).not.toThrow();
  });

  it('strips JSON-encoded orphan low surrogate', () => {
    const json = '{"content":"hello\\uDC00world"}';
    const clean = stripJsonSurrogates(json);
    expect(clean).toBe('{"content":"helloworld"}');
  });

  it('preserves JSON-encoded valid surrogate pair (emoji)', () => {
    // 🚀 = \uD83D\uDE80 — valid pair, should NOT be stripped
    const json = '{"content":"rocket\\uD83D\\uDE80!"}';
    const clean = stripJsonSurrogates(json);
    expect(clean).toBe(json);
    const parsed = JSON.parse(clean);
    expect(parsed.content).toBe('rocket🚀!');
  });

  it('strips orphan high but keeps valid pair in same string', () => {
    const json = '{"content":"\\uD800ok\\uD83D\\uDE80"}';
    const clean = stripJsonSurrogates(json);
    expect(clean).toBe('{"content":"ok\\uD83D\\uDE80"}');
  });

  it('handles real-world JSONL line with corrupt tool result', () => {
    // Simulate a stored tool result with orphan surrogate from truncated emoji
    const jsonLine = '{"role":"tool","content":"data at pos 4000\\uD83Dmore text"}';
    const clean = stripJsonSurrogates(jsonLine);
    const parsed = JSON.parse(clean);
    expect(parsed.content).toBe('data at pos 4000more text');
    // Verify re-serialization is safe for API
    expect(() => JSON.stringify(parsed)).not.toThrow();
  });

  it('also strips raw orphan surrogate chars', () => {
    const json = 'hello\uD800world';
    expect(stripJsonSurrogates(json)).toBe('helloworld');
  });
});
