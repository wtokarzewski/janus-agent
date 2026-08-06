import { describe, it, expect } from 'vitest';
import { parseLifecycleCommand } from '../../src/channels/lifecycle-command.js';

describe('parseLifecycleCommand', () => {
  it('recognises a restart', () => {
    expect(parseLifecycleCommand('/restart')).toEqual({ action: 'restart' });
  });

  it('requires "now" to shut down', () => {
    // A stray /shutdown in the family group would take the bot away from
    // everyone, and only someone at the server could bring it back.
    expect(parseLifecycleCommand('/shutdown')).toEqual({ action: 'shutdown-unconfirmed' });
    expect(parseLifecycleCommand('/shutdown now')).toEqual({ action: 'shutdown' });
  });

  it('tolerates case and extra spacing', () => {
    expect(parseLifecycleCommand('  /Restart ')).toEqual({ action: 'restart' });
    expect(parseLifecycleCommand('/SHUTDOWN   NOW')).toEqual({ action: 'shutdown' });
  });

  it('ignores anything else', () => {
    expect(parseLifecycleCommand('/restart please')).toBeNull();
    expect(parseLifecycleCommand('restart')).toBeNull();
    expect(parseLifecycleCommand('/shutdown later')).toBeNull();
    expect(parseLifecycleCommand('what does /restart do?')).toBeNull();
  });
});
