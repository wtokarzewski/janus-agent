import { describe, it, expect } from 'vitest';
import { resolveOwnerTargets } from '../../src/utils/notify-owner.js';

const user = (id: string, identities: { channel: string; channelUserId?: string; channelUsername?: string }[]) =>
  ({ id, name: id, identities });

describe('resolveOwnerTargets', () => {
  it('targets the configured owners on channels where they have an ID', () => {
    const targets = resolveOwnerTargets({
      ownerIds: ['wojtek'],
      users: [
        user('wojtek', [{ channel: 'telegram', channelUserId: '111' }]),
        user('monika', [{ channel: 'telegram', channelUserId: '222' }]),
      ],
    });

    expect(targets).toEqual([{ channel: 'telegram', chatId: '111' }]);
  });

  it('falls back to the first user when no owners are configured', () => {
    const targets = resolveOwnerTargets({
      ownerIds: [],
      users: [user('wojtek', [{ channel: 'telegram', channelUserId: '111' }])],
    });

    expect(targets).toEqual([{ channel: 'telegram', chatId: '111' }]);
  });

  it('skips identities that only carry a username — there is no chat to reach', () => {
    const targets = resolveOwnerTargets({
      ownerIds: ['wojtek'],
      users: [user('wojtek', [{ channel: 'telegram', channelUsername: 'wojtek' }])],
    });

    expect(targets).toEqual([]);
  });

  it('returns nothing when there are no users at all', () => {
    expect(resolveOwnerTargets({ ownerIds: ['wojtek'], users: [] })).toEqual([]);
  });
});

describe('resolveUserTargets', () => {
  it('reaches every configured user in their DM', async () => {
    const { resolveUserTargets } = await import('../../src/utils/notify-owner.js');

    const targets = resolveUserTargets({
      users: [
        user('wojtek', [{ channel: 'telegram', channelUserId: '111' }]),
        user('monika', [{ channel: 'telegram', channelUserId: '222' }]),
      ],
    });

    expect(targets).toEqual([
      { channel: 'telegram', chatId: '111' },
      { channel: 'telegram', chatId: '222' },
    ]);
  });

  it('skips a user with no addressable identity', async () => {
    const { resolveUserTargets } = await import('../../src/utils/notify-owner.js');

    const targets = resolveUserTargets({
      users: [user('wojtek', [{ channel: 'telegram', channelUsername: 'wojtek' }])],
    });

    expect(targets).toEqual([]);
  });
});
