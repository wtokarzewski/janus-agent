import { describe, it, expect } from 'vitest';
import type { LLMMessage, UserContentBlock } from '../../src/llm/types.js';
import type { ImageAttachment } from '../../src/bus/types.js';

describe('vision types', () => {
  it('LLMMessage user role accepts string content', () => {
    const msg: LLMMessage = { role: 'user', content: 'hello' };
    expect(msg.content).toBe('hello');
  });

  it('LLMMessage user role accepts multimodal content blocks', () => {
    const blocks: UserContentBlock[] = [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' } },
    ];
    const msg: LLMMessage = { role: 'user', content: blocks };
    expect(Array.isArray(msg.content)).toBe(true);
  });

  it('ImageAttachment has correct shape', () => {
    const attachment: ImageAttachment = {
      data: Buffer.from('fake-image-bytes').toString('base64'),
      mimeType: 'image/jpeg',
    };
    expect(attachment.data).toBeTruthy();
    expect(attachment.mimeType).toBe('image/jpeg');
  });
});
