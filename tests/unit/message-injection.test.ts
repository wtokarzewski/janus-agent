/**
 * Tests for cross-session message injection — when the message tool delivers
 * a message to another user, a ghost message is appended to the recipient's
 * session so the agent remembers what it sent.
 */

import { describe, it, expect, vi } from 'vitest';
import { MessageTool } from '../../src/tools/builtin/message.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import type { RequestContext } from '../../src/tools/types.js';

describe('MessageTool cross-session injection', () => {
  it('injects ghost message into recipient session when chatIds differ', async () => {
    const bus = new MessageBus();
    const injected: Array<{ channel: string; chatId: string; content: string }> = [];
    const injector = async (channel: string, chatId: string, content: string) => {
      injected.push({ channel, chatId, content });
    };

    const tool = new MessageTool(bus, injector);
    const reqCtx: RequestContext = { chatId: '111', sentTargets: [] };

    await tool.execute({ channel: 'telegram', chat_id: '222', content: 'Hello!' }, reqCtx);

    expect(injected).toHaveLength(1);
    expect(injected[0].channel).toBe('telegram');
    expect(injected[0].chatId).toBe('222');
    expect(injected[0].content).toBe('Hello!');
  });

  it('skips injection when source and target chatId match', async () => {
    const bus = new MessageBus();
    const injected: Array<{ channel: string; chatId: string; content: string }> = [];
    const injector = async (channel: string, chatId: string, content: string) => {
      injected.push({ channel, chatId, content });
    };

    const tool = new MessageTool(bus, injector);
    const reqCtx: RequestContext = { chatId: '222', sentTargets: [] };

    await tool.execute({ channel: 'telegram', chat_id: '222', content: 'Self-message' }, reqCtx);

    expect(injected).toHaveLength(0);
  });

  it('skips injection for system channel messages', async () => {
    const bus = new MessageBus();
    const injected: Array<{ channel: string; chatId: string; content: string }> = [];
    const injector = async (channel: string, chatId: string, content: string) => {
      injected.push({ channel, chatId, content });
    };

    const tool = new MessageTool(bus, injector);
    const reqCtx: RequestContext = { chatId: 'cron:123', sentTargets: [] };

    await tool.execute({ channel: 'system', chat_id: 'heartbeat', content: 'Internal' }, reqCtx);

    expect(injected).toHaveLength(0);
  });

  it('still sends message even if injector throws', async () => {
    const bus = new MessageBus();
    const published: unknown[] = [];
    bus.registerHandler('telegram', async (msg) => { published.push(msg); });
    const ac = new AbortController();
    const dispatcherPromise = bus.startDispatcher(ac.signal);

    const injector = async () => { throw new Error('Session write failed'); };
    const tool = new MessageTool(bus, injector);
    const reqCtx: RequestContext = { chatId: '111', sentTargets: [] };

    const result = await tool.execute({ channel: 'telegram', chat_id: '222', content: 'Hi' }, reqCtx);

    expect(result).toBe('Message sent to telegram:222');

    // Give dispatcher a moment to process
    await new Promise(r => setTimeout(r, 50));
    ac.abort();
    await Promise.allSettled([dispatcherPromise]);

    expect(published).toHaveLength(1);
  });

  it('works without injector (backward compatible)', async () => {
    const bus = new MessageBus();
    const tool = new MessageTool(bus); // no injector
    const reqCtx: RequestContext = { chatId: '111', sentTargets: [] };

    const result = await tool.execute({ channel: 'telegram', chat_id: '222', content: 'Hi' }, reqCtx);
    expect(result).toBe('Message sent to telegram:222');
  });
});

describe('MessageBus session ownership', () => {
  it('separates processing and steering by channel as well as chat ID', () => {
    const bus = new MessageBus();
    const first = { id: '1', channel: 'telegram', chatId: '123', content: 'a', author: 'user', timestamp: new Date() };
    const second = { ...first, id: '2', channel: 'discord', content: 'b' };
    bus.markProcessing(bus.sessionKey(first));
    expect(bus.isProcessing(first)).toBe(true);
    expect(bus.isProcessing(second)).toBe(false);
    bus.pushSteering(first);
    bus.pushSteering(second);
    expect(bus.drainSteering(bus.sessionKey(first))).toEqual([first]);
    expect(bus.drainSteering(bus.sessionKey(second))).toEqual([second]);
  });

  it('isProcessing returns true for active chats', () => {
    const bus = new MessageBus();
    bus.markProcessing('main:telegram:chat1');
    expect(bus.isProcessing('main:telegram:chat1')).toBe(true);
    expect(bus.isProcessing('main:telegram:chat2')).toBe(false);
  });

  it('clearProcessing removes the entry when no steering pending', () => {
    const bus = new MessageBus();
    bus.markProcessing('main:telegram:chat1');
    bus.clearProcessing('main:telegram:chat1');
    expect(bus.isProcessing('main:telegram:chat1')).toBe(false);
  });

  it('clearProcessing keeps entry alive when steering messages pending', () => {
    const bus = new MessageBus();
    bus.markProcessing('main:telegram:chat1');

    bus.pushSteering({
      id: '1', channel: 'telegram', chatId: 'chat1', content: 'msg1',
      author: 'user', timestamp: new Date(),
    });
    bus.pushSteering({
      id: '2', channel: 'telegram', chatId: 'chat1', content: 'msg2',
      author: 'user', timestamp: new Date(),
    });

    // After clearProcessing, chat stays "processing" because msg2 is still pending
    bus.clearProcessing('main:telegram:chat1');
    expect(bus.isProcessing('main:telegram:chat1')).toBe(true);

    // Second clearProcessing re-queues msg2, keeps entry alive (msg2 in flight)
    bus.clearProcessing('main:telegram:chat1');
    expect(bus.isProcessing('main:telegram:chat1')).toBe(true);

    // Third clearProcessing — no more steering → now it clears
    bus.clearProcessing('main:telegram:chat1');
    expect(bus.isProcessing('main:telegram:chat1')).toBe(false);
  });

  it('keeps a live turn busy after more than five minutes', () => {
    const bus = new MessageBus();
    bus.markProcessing('main:telegram:chat1');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000);
    try { expect(bus.isProcessing('main:telegram:chat1')).toBe(true); }
    finally { clock.mockRestore(); }
  });

  it('re-queues ONE steering message at a time (serialization)', () => {
    const bus = new MessageBus();
    bus.markProcessing('main:telegram:chat1');

    bus.pushSteering({
      id: '1', channel: 'telegram', chatId: 'chat1', content: 'first',
      author: 'user', timestamp: new Date(),
    });
    bus.pushSteering({
      id: '2', channel: 'telegram', chatId: 'chat1', content: 'second',
      author: 'user', timestamp: new Date(),
    });

    // clearProcessing re-queues only the first message
    bus.clearProcessing('main:telegram:chat1');

    // Second message should still be in steering buffer
    const remaining = bus.drainSteering('main:telegram:chat1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('second');
  });
});
