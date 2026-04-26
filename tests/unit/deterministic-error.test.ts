import { describe, it, expect } from 'vitest';
import { isDeterministicError } from '../../src/agent/agent-loop.js';

describe('isDeterministicError', () => {
  it('detects edit_file old_string not found', () => {
    expect(isDeterministicError('Error: old_string not found in file')).toBe(true);
  });

  it('detects edit_file old_string not unique', () => {
    expect(isDeterministicError('Error: old_string not unique — found 3 matches')).toBe(true);
  });

  it('detects ENOENT', () => {
    expect(isDeterministicError('Error: ENOENT: no such file or directory')).toBe(true);
  });

  it('detects EACCES', () => {
    expect(isDeterministicError('Error: EACCES: permission denied')).toBe(true);
  });

  it('detects EISDIR', () => {
    expect(isDeterministicError('Error: EISDIR: illegal operation on a directory')).toBe(true);
  });

  it('detects ENOTDIR', () => {
    expect(isDeterministicError('Error: ENOTDIR: not a directory')).toBe(true);
  });

  it('returns false for transient network error', () => {
    expect(isDeterministicError('Error: fetch failed: ETIMEDOUT')).toBe(false);
  });

  it('returns false for rate limit error', () => {
    expect(isDeterministicError('Error: 429 Too Many Requests')).toBe(false);
  });

  it('returns false for generic server error', () => {
    expect(isDeterministicError('Error: 500 Internal Server Error')).toBe(false);
  });

  it('returns false for empty error', () => {
    expect(isDeterministicError('Error:')).toBe(false);
  });
});
