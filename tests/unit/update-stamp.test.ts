import { describe, it, expect, beforeAll } from 'vitest';
import { formatUpdateStamp, readCommitInfo } from '../../src/utils/update-stamp.js';
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

describe('readCommitInfo', () => {
  it('reads the current commit of this checkout', async () => {
    // The format string used to contain a pipe, which the shell ate on
    // Windows: git failed, the stamp silently degraded to the version alone.
    const info = await readCommitInfo(process.cwd());

    expect(info).not.toBeNull();
    expect(info!.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(Number.isNaN(new Date(info!.committedAt).getTime())).toBe(false);
  });

  it('returns null outside a repository', async () => {
    expect(await readCommitInfo('/')).toBeNull();
  });
});

describe('formatCommitList', () => {
  it('renders one bullet per commit subject', async () => {
    const { formatCommitList } = await import('../../src/utils/update-stamp.js');

    expect(formatCommitList('fix(a): one\nfeat(b): two')).toBe('• fix(a): one\n• feat(b): two');
  });

  it('caps the list and says how many were left out', async () => {
    const { formatCommitList } = await import('../../src/utils/update-stamp.js');
    const subjects = Array.from({ length: 8 }, (_, i) => `commit ${i + 1}`).join('\n');

    const out = formatCommitList(subjects, 3);

    expect(out).toBe('• commit 1\n• commit 2\n• commit 3\n…and 5 more');
  });

  it('ignores blank lines and surrounding whitespace', async () => {
    const { formatCommitList } = await import('../../src/utils/update-stamp.js');

    expect(formatCommitList('\n  fix: one  \n\n')).toBe('• fix: one');
  });

  it('returns an empty string when there is nothing to list', async () => {
    const { formatCommitList } = await import('../../src/utils/update-stamp.js');

    expect(formatCommitList('   ')).toBe('');
  });
});
