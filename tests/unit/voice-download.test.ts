import { it, expect, vi, afterEach } from 'vitest';
import { downloadVoice } from '../../src/channels/voice-download.js';
afterEach(() => vi.restoreAllMocks());
it('bounds downloads without Content-Length and cancels the reader', async () => {
  const cancelled = vi.fn();
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); }, cancel: cancelled });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
  await expect(downloadVoice('https://example.test', 10, new AbortController().signal)).rejects.toThrow('size limit');
  expect(cancelled).toHaveBeenCalledOnce();
});
it('rejects an oversized Content-Length before reading', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('abc', { headers: { 'content-length': '100' } }));
  await expect(downloadVoice('https://example.test', 10, new AbortController().signal)).rejects.toThrow('size limit');
});
it('returns a complete permitted download', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('abc'));
  expect(Buffer.from(await downloadVoice('https://example.test', 10, new AbortController().signal)).toString()).toBe('abc');
});
