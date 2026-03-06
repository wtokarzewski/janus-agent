import { describe, it, expect } from 'vitest';
import { getShellConfig, killProcessTree } from '../../src/utils/shell.js';

describe('getShellConfig', () => {
  it('should return a shell and args', () => {
    const config = getShellConfig();
    expect(config.shell).toBeTruthy();
    expect(config.args).toBeInstanceOf(Array);
    expect(config.args.length).toBeGreaterThanOrEqual(1);
    // args should be -c (bash/sh) or /c (cmd.exe)
    expect(['-c', '/c']).toContain(config.args[0]);
  });

  it('should return consistent results (cached)', () => {
    const a = getShellConfig();
    const b = getShellConfig();
    expect(a).toBe(b); // same object reference (cached)
  });
});

describe('killProcessTree', () => {
  it('should not throw for invalid pids', () => {
    expect(() => killProcessTree(-1)).not.toThrow();
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(NaN)).not.toThrow();
    expect(() => killProcessTree(Infinity)).not.toThrow();
  });

  it('should not throw for non-existent pid', () => {
    // PID 999999 almost certainly doesn't exist
    expect(() => killProcessTree(999999)).not.toThrow();
  });
});
