import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../../src/utils/version.js';

describe('isNewerVersion', () => {
  it('detects newer patch', () => {
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true);
  });

  it('detects newer minor', () => {
    expect(isNewerVersion('1.0.0', '1.1.0')).toBe(true);
  });

  it('detects newer major', () => {
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true);
  });

  it('returns false for same version', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false for older version', () => {
    expect(isNewerVersion('1.1.0', '1.0.0')).toBe(false);
  });

  it('handles v prefix in latest', () => {
    expect(isNewerVersion('1.0.0', 'v1.0.1')).toBe(true);
  });
});
