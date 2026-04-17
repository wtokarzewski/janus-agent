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

describe('MessageBus processing TTL', () => {
  it('isProcessing returns true for active chats', () => {
    const bus = new MessageBus();
    bus.markProcessing('chat1');
    expect(bus.isProcessing('chat1')).toBe(true);
    expect(bus.isProcessing('chat2')).toBe(false);
  });

  it('clearProcessing removes the entry', () => {
    const bus = new MessageBus();
    bus.markProcessing('chat1');
    bus.clearProcessing('chat1');
    expect(bus.isProcessing('chat1')).toBe(false);
  });

  it('auto-clears stale entries older than 5 minutes', () => {
    const bus = new MessageBus();
    bus.markProcessing('chat1');
    // Advance time past the 5-minute TTL
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(Date.now()) // for the first isProcessing internal check
      .mockRestore();
    // Instead: directly manipulate by re-marking with old timestamp
    // Access private field for testing
    const processingChats = (bus as unknown as { processingChats: Map<string, number> }).processingChats;
    processingChats.set('chat1', Date.now() - 6 * 60 * 1000); // 6 minutes ago

    expect(bus.isProcessing('chat1')).toBe(false);
  });

  it('re-queues steering messages when stale entry auto-clears', () => {
    const bus = new MessageBus();
    bus.markProcessing('chat1');

    // Buffer a steering message
    bus.pushSteering({
      id: '1', channel: 'telegram', chatId: 'chat1', content: 'Hej',
      author: 'user', timestamp: new Date(),
    });

    // Make the processing entry stale
    const processingChats = (bus as unknown as { processingChats: Map<string, number> }).processingChats;
    processingChats.set('chat1', Date.now() - 6 * 60 * 1000);

    // isProcessing should auto-clear and re-queue
    expect(bus.isProcessing('chat1')).toBe(false);

    // Steering should have been re-queued (drained from buffer)
    expect(bus.drainSteering('chat1')).toHaveLength(0); // already re-queued
  });
});
