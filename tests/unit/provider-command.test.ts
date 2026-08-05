import { describe, it, expect } from 'vitest';
import { handleProviderCommand } from '../../src/channels/provider-command.js';

function registry(entries?: { providerName: string; model: string; priority: number; demoted?: boolean }[]) {
  const state = {
    pinned: undefined as string | undefined,
    entries: entries ?? [
      { providerName: 'anthropic', model: 'claude-sonnet-5', priority: 0, demoted: false },
      { providerName: 'codex', model: 'gpt-5.6-terra', priority: 1, demoted: false },
    ],
  };
  return {
    state,
    status: () => state.entries.map(e => ({ ...e, demoted: !!e.demoted, pinned: e.providerName === state.pinned })),
    pin: (name: string) => {
      if (!state.entries.some(e => e.providerName === name)) return false;
      state.pinned = name;
      return true;
    },
    unpin: () => { state.pinned = undefined; },
    getPinned: () => state.pinned,
  };
}

describe('handleProviderCommand', () => {
  it('numbers the providers with role, model and which one is current', () => {
    const reply = handleProviderCommand(registry(), undefined);

    expect(reply).toContain('1. anthropic — claude-sonnet-5 — default (current)');
    expect(reply).toContain('2. codex — gpt-5.6-terra — fallback');
  });

  it('switches by the number from that list', () => {
    const reg = registry();

    const reply = handleProviderCommand(reg, '2');

    expect(reg.getPinned()).toBe('codex');
    expect(reply).toContain('codex');
    expect(reply).toContain('2. codex — gpt-5.6-terra — fallback (current, pinned)');
  });

  it('still accepts the provider name', () => {
    const reg = registry();

    handleProviderCommand(reg, 'codex');

    expect(reg.getPinned()).toBe('codex');
  });

  it('rejects a number outside the list', () => {
    const reg = registry();

    const reply = handleProviderCommand(reg, '5');

    expect(reg.getPinned()).toBeUndefined();
    expect(reply).toMatch(/0–2|unknown/i);
  });

  it('rejects an unknown name and shows what is configured', () => {
    const reg = registry();

    const reply = handleProviderCommand(reg, 'gemini');

    expect(reg.getPinned()).toBeUndefined();
    expect(reply).toContain('anthropic');
    expect(reply).toContain('codex');
  });

  it.each(['0', 'auto'])('returns to automatic order on "%s"', (arg) => {
    const reg = registry();
    reg.pin('codex');

    const reply = handleProviderCommand(reg, arg);

    expect(reg.getPinned()).toBeUndefined();
    expect(reply).toMatch(/automatic/i);
  });

  it('offers the reset as entry 0 in the same menu', () => {
    const reply = handleProviderCommand(registry(), undefined);

    expect(reply).toContain('0. automatic');
  });

  it('marks the current one correctly when the default is cooling down', () => {
    // With the primary demoted, traffic really is on the fallback — say so.
    const reply = handleProviderCommand(registry([
      { providerName: 'anthropic', model: 'claude-sonnet-5', priority: 0, demoted: true },
      { providerName: 'codex', model: 'gpt-5.6-terra', priority: 1 },
    ]), undefined);

    expect(reply).toContain('1. anthropic — claude-sonnet-5 — default (cooling down after failures)');
    expect(reply).toContain('2. codex — gpt-5.6-terra — fallback (current)');
  });

  it('says a switch is not written to config', () => {
    const reply = handleProviderCommand(registry(), '2');

    expect(reply).toMatch(/restart/i);
  });

  it('handles an instance with a single provider', () => {
    const reply = handleProviderCommand(registry([
      { providerName: 'anthropic', model: 'claude-sonnet-5', priority: 0 },
    ]), undefined);

    expect(reply).toContain('1. anthropic — claude-sonnet-5 — default (current)');
    expect(reply).not.toContain('fallback');
  });
});
