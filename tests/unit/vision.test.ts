import { describe, it, expect } from 'vitest';
import type { LLMMessage, UserContentBlock } from '../../src/llm/types.js';
import type { ImageAttachment } from '../../src/bus/types.js';
import { JanusConfigSchema } from '../../src/config/schema.js';

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

describe('vision config', () => {
  it('defaults to enabled with 10MB limit', () => {
    const config = JanusConfigSchema.parse({});
    expect(config.vision.enabled).toBe(true);
    expect(config.vision.maxFileSizeMb).toBe(10);
  });

  it('respects explicit config', () => {
    const config = JanusConfigSchema.parse({ vision: { enabled: false, maxFileSizeMb: 5 } });
    expect(config.vision.enabled).toBe(false);
    expect(config.vision.maxFileSizeMb).toBe(5);
  });
});
