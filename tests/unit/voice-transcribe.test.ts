import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transcribeVoice } from '../../src/channels/voice-transcribe.js';

describe('transcribeVoice', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends audio to Groq Whisper API and returns transcript', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'Hello world' }), { status: 200 }),
    );

    const audio = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // OGG magic bytes
    const result = await transcribeVoice(audio, 'gsk_test_key');

    expect(result).toBe('Hello world');
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(opts?.method).toBe('POST');
    expect((opts?.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test_key');
    expect(opts?.body).toBeInstanceOf(FormData);
  });

  it('passes language parameter when provided', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'Cześć' }), { status: 200 }),
    );

    const audio = new Uint8Array([1, 2, 3]);
    const result = await transcribeVoice(audio, 'gsk_test', 'pl');

    expect(result).toBe('Cześć');

    const body = vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as FormData;
    expect(body.get('language')).toBe('pl');
    expect(body.get('model')).toBe('whisper-large-v3-turbo');
  });

  it('throws on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Rate limited', { status: 429 }),
    );

    const audio = new Uint8Array([1, 2, 3]);
    await expect(transcribeVoice(audio, 'gsk_test')).rejects.toThrow('Groq Whisper API error: HTTP 429');
  });

  it('returns empty string when text field is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const audio = new Uint8Array([1, 2, 3]);
    const result = await transcribeVoice(audio, 'gsk_test');
    expect(result).toBe('');
  });

  it('does not include language in form when not provided', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'Hello' }), { status: 200 }),
    );

    const audio = new Uint8Array([1, 2, 3]);
    await transcribeVoice(audio, 'gsk_test');

    const body = vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as FormData;
    expect(body.get('language')).toBeNull();
  });
});
