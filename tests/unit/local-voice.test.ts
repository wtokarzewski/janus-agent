import { describe, it, expect, vi, afterEach } from 'vitest';
import { JanusConfigSchema } from '../../src/config/schema.js';
import { transcribeVoice } from '../../src/channels/voice-transcribe.js';

afterEach(() => vi.restoreAllMocks());
describe('voice provider configuration', () => {
  it('accepts local transcription without an API key', () => {
    const config = JanusConfigSchema.parse({ voice: { enabled: true, provider: 'local' } });
    expect(config.voice.provider).toBe('local');
    expect(config.voice.apiKey).toBeUndefined();
  });
  it('preserves legacy disabled defaults', () => {
    expect(JanusConfigSchema.parse({}).voice).toMatchObject({ enabled: false, provider: 'groq', maxDurationSec: 300 });
  });
  it('rejects unbounded queue and process settings', () => {
    expect(JanusConfigSchema.safeParse({ voice: { local: { threads: 0, maxQueuedJobs: -1 } } }).success).toBe(false);
  });
});

it('does not label an MP3 attachment as OGG', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"text":"hello"}'));
  await transcribeVoice(new Uint8Array([1]), 'test', 'pl', { mimeType: 'audio/mpeg', filename: 'clip.mp3' });
  const form = fetch.mock.calls[0][1]!.body as FormData;
  const file = form.get('file') as File;
  expect(file.type).toBe('audio/mpeg');
  expect(file.name).toBe('clip.mp3');
});
