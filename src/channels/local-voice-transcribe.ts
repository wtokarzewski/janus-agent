import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { JanusConfig } from '../config/schema.js';
import { runVoiceProcess } from './voice-process.js';

const SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2;
const MAX_TRANSCRIPT_BYTES = 100_000;
const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;
const CONVERSION_TIMEOUT_MS = 30_000;
export type VoiceConfig = JanusConfig['voice'];

export async function checkLocalVoice(config: VoiceConfig): Promise<void> {
  for (const key of ['executablePath', 'converterPath', 'modelPath'] as const) {
    const path = config.local[key];
    if (!isAbsolute(path) || /\.(?:cmd|bat|ps1)$/i.test(path)) throw new Error(`Set voice.local.${key} to an absolute file path`);
    try {
      if (!(await stat(path)).isFile()) throw new Error('Not a file');
      await access(path, key === 'modelPath' || process.platform === 'win32' ? constants.R_OK : constants.X_OK);
    } catch { throw new Error(`Cannot access voice.local.${key}; check installation`); }
  }
}

/** Whitelist actual containers; never let a supplied playlist choose local/network inputs. */
export function audioContainer(audio: Uint8Array): string {
  const b = Buffer.from(audio);
  if (b.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (b.subarray(0, 4).toString() === 'fLaC') return 'flac';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE') return 'wav';
  if (b.subarray(4, 8).toString() === 'ftyp') return 'mov';
  if (b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  throw new Error('Unsupported audio; send an OGG voice message, MP3, WAV, FLAC or M4A file');
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function transcribeLocalVoice(audio: Uint8Array, config: VoiceConfig, signal: AbortSignal,
  run: typeof runVoiceProcess = runVoiceProcess,
): Promise<{ text: string; durationSec: number; conversionMs: number; inferenceMs: number }> {
  signal.throwIfAborted();
  await checkLocalVoice(config);
  if (audio.length > config.maxFileSizeMb * 1_048_576) throw new Error('Audio exceeds the file size limit');
  const container = audioContainer(audio);
  const dir = await mkdtemp(join(tmpdir(), 'janus-voice-'));
  const owner = new AbortController();
  const timer = setTimeout(() => owner.abort(), config.local.timeoutMs);
  const workSignal = AbortSignal.any([signal, owner.signal]);
  try {
    const input = join(dir, 'input.audio');
    const normalized = join(dir, 'input.wav');
    const output = join(dir, 'transcript');
    await writeFile(input, audio);
    const started = Date.now();
    const pcm = await run(config.local.converterPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', String(config.local.threads),
      '-protocol_whitelist', 'file,pipe', '-f', container, '-i', input,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-threads', String(config.local.threads), '-f', 's16le', 'pipe:1',
    ], { signal: AbortSignal.any([workSignal, AbortSignal.timeout(CONVERSION_TIMEOUT_MS)]),
      maxOutputBytes: config.maxDurationSec * PCM_BYTES_PER_SECOND });
    workSignal.throwIfAborted();
    if (!pcm.length || pcm.length % 2) throw new Error('Audio has no valid decoded samples');
    const conversionMs = Date.now() - started;
    await writeFile(normalized, wav(pcm));
    const inferenceStart = Date.now();
    await run(config.local.executablePath, [
      '-m', config.local.modelPath, '-f', normalized, '-l', config.language ?? 'auto',
      '-t', String(config.local.threads), '-ng', '-nt', '-otxt', '-of', output,
    ], { signal: workSignal, maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES });
    workSignal.throwIfAborted();
    if ((await stat(`${output}.txt`)).size > MAX_TRANSCRIPT_BYTES) throw new Error('Transcript exceeds its size limit');
    const text = (await readFile(`${output}.txt`, 'utf8')).trim();
    if (!text) throw new Error('No speech was recognized');
    return { text, durationSec: pcm.length / PCM_BYTES_PER_SECOND, conversionMs, inferenceMs: Date.now() - inferenceStart };
  } finally {
    clearTimeout(timer);
    owner.abort();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
