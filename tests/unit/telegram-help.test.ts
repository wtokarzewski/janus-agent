import { describe, it, expect } from 'vitest';
import { TELEGRAM_COMMANDS, formatTelegramHelp } from '../../src/channels/telegram-help.js';

describe('formatTelegramHelp', () => {
  it('lists every command with what it does', () => {
    const help = formatTelegramHelp();

    for (const cmd of TELEGRAM_COMMANDS) {
      expect(help).toContain(cmd.name);
      expect(help).toContain(cmd.description);
    }
  });

  it('documents the commands the channel actually handles', () => {
    const names = TELEGRAM_COMMANDS.map(c => c.name);

    expect(names).toEqual(['/help', '/provider', '/model', '/stop', '/whoami']);
  });

  it('says the rest is a normal conversation', () => {
    // Without this line the list reads like the bot only takes commands.
    expect(formatTelegramHelp()).toMatch(/napisz|write|chat/i);
  });
});
