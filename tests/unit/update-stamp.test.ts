import { describe, it, expect, beforeAll } from 'vitest';
import { formatUpdateStamp } from '../../src/utils/update-stamp.js';
import { setTimezone } from '../../src/utils/date.js';

describe('formatUpdateStamp', () => {
  // The stamp renders in the configured zone, so pin one — CI runs in UTC.
  beforeAll(() => setTimezone('Europe/Warsaw'));

  it('combines version, short hash and commit time', () => {
    const stamp = formatUpdateStamp('0.15.0', { hash: '6e1ed1f', committedAt: '2026-08-05T21:14:03+02:00' });

    expect(stamp).toBe('v0.15.0 • 6e1ed1f • 2026-08-05 21:14');
  });

  it('falls back to the version alone without git metadata', () => {
    // Tarball installs have no repository to ask.
    expect(formatUpdateStamp('0.15.0', null)).toBe('v0.15.0');
  });

  it('keeps the version when the commit date is unusable', () => {
    expect(formatUpdateStamp('0.15.0', { hash: '6e1ed1f', committedAt: 'not-a-date' }))
      .toBe('v0.15.0 • 6e1ed1f');
  });
});
