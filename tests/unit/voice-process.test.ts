import { it, expect } from 'vitest';
import { runVoiceProcess } from '../../src/channels/voice-process.js';

it('passes paths, Unicode and metacharacters literally without a shell', async () => {
  const value = 'C:/test space/zażółć & $(echo unwanted); model.bin';
  const result = await runVoiceProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value],
    { signal: new AbortController().signal, maxOutputBytes: 1000 });
  expect(result.toString()).toBe(value);
});
it('kills a running child on timeout and waits for its close', async () => {
  await expect(runVoiceProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { signal: AbortSignal.timeout(100), maxOutputBytes: 100 })).rejects.toThrow('cancelled or timed out');
});
it('rejects oversized output', async () => {
  await expect(runVoiceProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'],
    { signal: AbortSignal.timeout(5000), maxOutputBytes: 10 })).rejects.toThrow('output exceeds');
});
it('does not expose stderr on a failing exit', async () => {
  await expect(runVoiceProcess(process.execPath, ['-e', 'process.stderr.write("SECRET");process.exit(2)'],
    { signal: AbortSignal.timeout(5000), maxOutputBytes: 100 })).rejects.toThrow('Voice executable failed; check audio, model and installation');
});
it('handles a missing binary without hanging', async () => {
  await expect(runVoiceProcess('/missing-voice-binary', [],
    { signal: AbortSignal.timeout(5000), maxOutputBytes: 100 })).rejects.toThrow('Cannot start');
});
it('does not spawn after cancellation', async () => {
  expect(() => runVoiceProcess(process.execPath, [], { signal: AbortSignal.abort(), maxOutputBytes: 100 })).toThrow();
});
