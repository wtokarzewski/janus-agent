import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { checkLocalVoice, transcribeLocalVoice } from '../channels/local-voice-transcribe.js';

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Explicit offline diagnostic: no gateway, LLM, Telegram or persistent session. */
export async function runVoiceCheck(options: { audio?: string; expect?: string; showText?: boolean }): Promise<void> {
  try {
    const { voice } = await loadConfig();
    await checkLocalVoice(voice);
    const artifacts = await Promise.all((['executablePath', 'converterPath', 'modelPath'] as const).map(async key => ({
      field: key, path: voice.local[key], sha256: await sha256(voice.local[key]),
    })));
    const report: Record<string, unknown> = { ready: true, platform: process.platform, architecture: process.arch, artifacts };
    if (options.audio) {
      const path = resolve(options.audio);
      if ((await stat(path)).size > voice.maxFileSizeMb * 1_048_576) throw new Error('Audio exceeds the file size limit');
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once('SIGINT', abort); process.once('SIGTERM', abort);
      try {
        const result = await transcribeLocalVoice(await readFile(path), voice, controller.signal);
        Object.assign(report, { durationSec: result.durationSec, conversionMs: result.conversionMs, inferenceMs: result.inferenceMs,
          realTimeFactor: (result.conversionMs + result.inferenceMs) / (result.durationSec * 1000) });
        if (options.showText) report.transcript = result.text;
        if (options.expect) {
          const normalize = (text: string) => text.toLocaleLowerCase('pl').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
          report.expectedTextFound = normalize(result.text).includes(normalize(options.expect));
          if (!report.expectedTextFound) process.exitCode = 1;
        }
      } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    } else if (options.expect) throw new Error('--expect requires --audio');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`Voice check failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
