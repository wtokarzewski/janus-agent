import { describe, it, expect } from 'vitest';
import { autoUpdateDisabled } from '../../src/utils/auto-update-switch.js';

describe('autoUpdateDisabled', () => {
  it('is off by default', () => {
    expect(autoUpdateDisabled({})).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes'])('honours JANUS_NO_AUTO_UPDATE=%s', (value) => {
    expect(autoUpdateDisabled({ JANUS_NO_AUTO_UPDATE: value })).toBe(true);
  });

  it.each(['0', 'false', '', 'no'])('ignores JANUS_NO_AUTO_UPDATE=%s', (value) => {
    // A stray empty or falsy value must not silently stop updates forever.
    expect(autoUpdateDisabled({ JANUS_NO_AUTO_UPDATE: value })).toBe(false);
  });
});
