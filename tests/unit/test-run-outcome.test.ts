import { describe, it, expect } from 'vitest';
import { classifyTestRun } from '../../src/utils/test-run-outcome.js';

/** Shape of the errors `promisify(execFile)` rejects with. */
function execError(props: Record<string, unknown>): Error {
  return Object.assign(new Error(String(props.message ?? 'command failed')), props);
}

describe('classifyTestRun', () => {
  it('treats a non-zero exit as a real test failure', () => {
    expect(classifyTestRun(execError({ code: 1, stdout: '2 tests failed' }))).toBe('failed');
  });

  it('treats a timeout as inconclusive — the suite never finished', () => {
    // Windows runs the suite far slower than CI; a killed runner says nothing
    // about the code that was just pulled.
    expect(classifyTestRun(execError({ killed: true, signal: 'SIGTERM' }))).toBe('inconclusive');
  });

  it('treats an output-buffer overflow as inconclusive', () => {
    expect(classifyTestRun(execError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))).toBe('inconclusive');
  });

  it('treats a missing runner as inconclusive', () => {
    expect(classifyTestRun(execError({ code: 'ENOENT' }))).toBe('inconclusive');
  });

  it('treats a spawn failure as inconclusive', () => {
    expect(classifyTestRun(execError({ code: 'EACCES' }))).toBe('inconclusive');
  });
});
