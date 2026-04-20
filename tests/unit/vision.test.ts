import { describe, it, expect } from 'vitest';
import { userContentText } from '../../src/llm/types.js';
import type { UserContentBlock } from '../../src/llm/types.js';

describe('userContentText helper', () => {
  it('returns string content as-is', () => {
    expect(userContentText('hello')).toBe('hello');
  });

  it('extracts text from multimodal blocks', () => {
    const blocks: UserContentBlock[] = [
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } },
      { type: 'text', text: 'Please describe.' },
    ];
    expect(userContentText(blocks)).toBe('What is this? Please describe.');
  });

  it('returns empty string for image-only content', () => {
    const blocks: UserContentBlock[] = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } },
    ];
    expect(userContentText(blocks)).toBe('');
  });
});

describe('provider image conversion', () => {
  it('OpenAI: converts UserContentBlock[] to image_url format', () => {
    const blocks: UserContentBlock[] = [
      { type: 'text', text: 'Describe this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' } },
    ];
    const openaiBlocks = blocks.map(b =>
      b.type === 'image'
        ? { type: 'image_url' as const, image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
        : { type: 'text' as const, text: b.text },
    );
    expect(openaiBlocks[0]).toEqual({ type: 'text', text: 'Describe this' });
    expect(openaiBlocks[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,abc123' },
    });
  });
});
