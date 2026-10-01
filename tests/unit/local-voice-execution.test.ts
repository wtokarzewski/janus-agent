import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, vi } from 'vitest';
import { JanusConfigSchema } from '../../src/config/schema.js';
import { audioContainer, checkLocalVoice, transcribeLocalVoice } from '../../src/channels/local-voice-transcribe.js';
import type { runVoiceProcess } from '../../src/channels/voice-process.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'voice-model-'));
  const model = join(dir, 'model.bin'); await writeFile(model, 'mock');
  const config = JanusConfigSchema.parse({ voice: { enabled: true, provider: 'local', language: 'pl', maxDurationSec: 1,
    local: { executablePath: process.execPath, converterPath: process.execPath, modelPath: model } } }).voice;
  return { config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
it('converts to WAV, requests Polish CPU transcription and removes all temporary files', async () => {
  const { config, cleanup } = await fixture(); let temp = '';
  const run: typeof runVoiceProcess = vi.fn(async (_exe, args, opts) => {
    if (args.includes('pipe:1')) { expect(opts.maxOutputBytes).toBe(32000); return Buffer.alloc(32000); }
    const path = args[args.indexOf('-f') + 1]; temp = dirname(path);
    expect((await readFile(path)).subarray(0, 4).toString()).toBe('RIFF');
    expect(args).toContain('pl'); expect(args).toContain('-ng');
    await writeFile(args[args.indexOf('-of') + 1] + '.txt', 'Nie zmieniaj 15 na 50.'); return Buffer.alloc(0);
  });
  try {
    const result = await transcribeLocalVoice(Buffer.from('OggSsynthetic'), config, new AbortController().signal, run);
    expect(result.text).toBe('Nie zmieniaj 15 na 50.'); expect(result.durationSec).toBe(1);
    await expect(access(temp)).rejects.toThrow();
  } finally { await cleanup(); }
});
it('cleans up on converter failure without running inference', async () => {
  const { config, cleanup } = await fixture(); let temp = '';
  const run = vi.fn<typeof runVoiceProcess>(async (_exe, args) => { temp = dirname(args[args.indexOf('-i') + 1]); throw new Error('decode failed'); });
  try {
    await expect(transcribeLocalVoice(Buffer.from('OggSbad'), config, new AbortController().signal, run)).rejects.toThrow('decode failed');
    await expect(access(temp)).rejects.toThrow(); expect(run).toHaveBeenCalledOnce();
  } finally { await cleanup(); }
});
it('rejects playlists before spawning', () => {
  expect(() => audioContainer(Buffer.from('#EXTM3U\nhttps://private.test/secret'))).toThrow('Unsupported');
});
it('reports missing model without requiring an API key', async () => {
  const { config, cleanup } = await fixture(); await cleanup();
  await expect(checkLocalVoice(config)).rejects.toThrow('modelPath');
});
it('discards late inference after cancellation and cleans up', async () => {
  const { config, cleanup } = await fixture(); const controller = new AbortController(); let temp = '';
  const run: typeof runVoiceProcess = async (_exe, args) => {
    if (args.includes('pipe:1')) return Buffer.alloc(32000);
    temp = dirname(args[args.indexOf('-f') + 1]); controller.abort();
    await writeFile(args[args.indexOf('-of') + 1] + '.txt', 'late'); return Buffer.alloc(0);
  };
  try {
    await expect(transcribeLocalVoice(Buffer.from('OggSfake'), config, controller.signal, run)).rejects.toThrow();
    await expect(access(temp)).rejects.toThrow();
  } finally { await cleanup(); }
});
