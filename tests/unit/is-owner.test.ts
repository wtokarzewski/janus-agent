import { describe, it, expect } from 'vitest';
import { isOwner } from '../../src/users/is-owner.js';

const config = (ownerIds: string[], userIds: string[]) => ({
  ownerIds,
  users: userIds.map(id => ({ id })),
});

describe('isOwner', () => {
  it('accepts a configured owner', () => {
    expect(isOwner('wojtek', config(['wojtek'], ['wojtek', 'monika']))).toBe(true);
  });

  it('rejects another household member', () => {
    // Operator commands change behaviour for every chat on the instance.
    expect(isOwner('monika', config(['wojtek'], ['wojtek', 'monika']))).toBe(false);
  });

  it('rejects an unidentified sender in multi-user mode', () => {
    expect(isOwner(undefined, config(['wojtek'], ['wojtek', 'monika']))).toBe(false);
  });

  it('falls back to the first user when no owners are configured', () => {
    expect(isOwner('wojtek', config([], ['wojtek', 'monika']))).toBe(true);
    expect(isOwner('monika', config([], ['wojtek', 'monika']))).toBe(false);
  });

  it('treats single-user mode (no users configured) as owner', () => {
    // CLI on a personal machine: there is nobody else to protect against.
    expect(isOwner(undefined, config([], []))).toBe(true);
  });
});
