import { describe, it, expect, vi } from 'vitest';
import { ReactTool } from '../../src/tools/builtin/react.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import type { RequestContext } from '../../src/tools/types.js';

function setup() {
  const bus = new MessageBus();
  const publish = vi.spyOn(bus, 'publishOutbound').mockResolvedValue(undefined);
  return { tool: new ReactTool(bus), publish };
}

const telegramCtx: RequestContext = { channel: 'telegram', chatId: '555', channelMessageId: 10 };

describe('ReactTool', () => {
  it('reacts to the current message by default', async () => {
    const { tool, publish } = setup();
    const result = await tool.execute({ emoji: '👍' }, telegramCtx);
    expect(result).toBe('Reacted 👍');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      channel: 'telegram', chatId: '555', type: 'reaction', reactTo: 10, content: '👍',
    });
  });

  it('uses an explicit message_id when given', async () => {
    const { tool, publish } = setup();
    await tool.execute({ emoji: '❤️', message_id: 7 }, telegramCtx);
    expect(publish.mock.calls[0][0]).toMatchObject({ reactTo: 7, content: '❤️' });
  });

  it('keeps the forum topic chatId as-is', async () => {
    const { tool, publish } = setup();
    await tool.execute({ emoji: '👍' }, { ...telegramCtx, chatId: '-100777/42' });
    expect(publish.mock.calls[0][0]).toMatchObject({ chatId: '-100777/42' });
  });

  it('refuses without an emoji', async () => {
    const { tool, publish } = setup();
    expect(await tool.execute({}, telegramCtx)).toMatch(/^Error: /);
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses when the conversation has no channel message (CLI, cron)', async () => {
    const { tool, publish } = setup();
    expect(await tool.execute({ emoji: '👍' }, { channel: 'cli', chatId: 'cli' })).toMatch(/^Error: /);
    expect(await tool.execute({ emoji: '👍', message_id: 5 }, { channel: 'cli', chatId: 'cli' })).toMatch(/^Error: /);
    expect(await tool.execute({ emoji: '👍' }, undefined)).toMatch(/^Error: /);
    expect(publish).not.toHaveBeenCalled();
  });
});
