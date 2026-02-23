import { describe, it, expect } from 'vitest';
import type { GateCheck } from '../../src/gates/types.js';

describe('GateCheck type', () => {
  it('should accept chatId in gate check', () => {
    const check: GateCheck = {
      tool: 'exec',
      action: 'rm -rf build/',
      args: { command: 'rm -rf build/' },
      chatId: '123456',
    };

    expect(check.chatId).toBe('123456');
  });

  it('should accept gate check without chatId (backward-compat)', () => {
    const check: GateCheck = {
      tool: 'exec',
      action: 'ls',
      args: { command: 'ls' },
    };

    expect(check.chatId).toBeUndefined();
  });
});
