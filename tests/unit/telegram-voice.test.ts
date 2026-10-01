import { Bot, type Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import { it, expect, vi, afterEach } from 'vitest';
import { TelegramChannel } from '../../src/channels/telegram-channel.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import { checkLocalVoice, transcribeLocalVoice } from '../../src/channels/local-voice-transcribe.js';
import { voiceQueue } from '../../src/channels/voice-queue.js';

vi.mock('../../src/channels/local-voice-transcribe.js', () => ({
  checkLocalVoice: vi.fn(async () => {}),
  transcribeLocalVoice: vi.fn(async () => ({ text: 'Nie zmieniaj 15 na 50.', durationSec: 1, conversionMs: 1, inferenceMs: 1 })),
}));
afterEach(async () => { voiceQueue.cancel(); await voiceQueue.idle(); vi.restoreAllMocks(); vi.clearAllMocks(); });
let nextId = 100;
async function fixture(options: { active?: boolean; allowlist?: string[] } = {}) {
  const config = createTestConfig({
    voice: { enabled: true, provider: 'local' },
    telegram: { enabled: true, allowlist: options.allowlist ?? ['1', '2', '-10'], groupPolicy: 'all' },
    users: [{ id: 'alice', name: 'Alice', identities: [{ channel: 'telegram', channelUserId: '1' }] },
      { id: 'bob', name: 'Bob', identities: [{ channel: 'telegram', channelUserId: '2' }] }],
  });
  const bot = new Bot('123:test', { botInfo: { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot',
    can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } });
  const send = vi.fn(); const download = vi.fn();
  const transform = async (_prev: unknown, method: string, payload: unknown) => {
    if (method === 'getFile') { download(payload); return { ok: true, result: { file_id: 'test', file_unique_id: 'unique', file_path: 'voice/test.oga' } }; }
    if (method === 'sendMessage') { send(payload); return { ok: true, result: { message_id: 999, date: 0, chat: { id: 1, type: 'private', first_name: 'Alice' }, text: 'status' } }; }
    return { ok: true, result: true };
  };
  // Synthetic responses deliberately implement only the methods used by this harness.
  bot.api.config.use(transform as Transformer);
  vi.spyOn(bot, 'start').mockResolvedValue(); vi.spyOn(bot, 'stop').mockResolvedValue();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('OggSsynthetic'));
  const bus = new MessageBus(); const publish = vi.spyOn(bus, 'publishInbound').mockResolvedValue();
  const steering = vi.spyOn(bus, 'pushSteering'); vi.spyOn(bus, 'isProcessing').mockReturnValue(options.active ?? false);
  const controller = new AbortController(); const channel = new TelegramChannel();
  const running = channel.start(bus, config, controller.signal, bot);
  await Promise.resolve();
  const update = (user = 1, topic?: number): Update => ({ update_id: ++nextId, message: {
    message_id: nextId, date: 0, from: { id: user, is_bot: false, first_name: user === 1 ? 'Alice' : 'Bob' },
    chat: topic ? { id: -10, type: 'supergroup', title: 'Test', is_forum: true } : { id: user, type: 'private', first_name: 'Test' },
    ...(topic ? { message_thread_id: topic } : {}),
    voice: { file_id: 'test', file_unique_id: 'unique', duration: 1, mime_type: 'audio/ogg', file_size: 10 },
  } });
  return { bot, config, update, send, download, publish, steering, stop: async () => { controller.abort(); await running; } };
}

it('routes local voice without an API key and preserves user identity', async () => {
  const f = await fixture();
  try {
    await f.bot.handleUpdate(f.update()); await voiceQueue.idle();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.publish.mock.calls[0][0]).toMatchObject({ chatId: '1', scope: { kind: 'user', id: 'alice' }, user: { userId: 'alice' }, isVoice: true, content: '[Voice message transcription]: Nie zmieniaj 15 na 50.' });
  } finally { await f.stop(); }
});
it('preserves forum topic, caption and reply when steering active work', async () => {
  const f = await fixture({ active: true });
  try {
    const update = f.update(2, 42); const msg = update.message!;
    delete msg.voice;
    Object.assign(msg, { audio: { file_id: 'test', file_unique_id: 'unique', duration: 1, mime_type: 'audio/mpeg', file_name: 'test.mp3' }, caption: 'Please check.',
      reply_to_message: { message_id: 1, date: 0, chat: msg.chat, from: { id: 2, is_bot: false, first_name: 'Bob' }, text: 'Earlier text' } });
    await f.bot.handleUpdate(update); await voiceQueue.idle();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.steering.mock.calls[0][0]).toMatchObject({ chatId: '-10/42', topicId: 42, user: { userId: 'bob' }, replyContext: 'Bob: Earlier text', content: '[Voice message transcription]: Nie zmieniaj 15 na 50. Please check.' });
  } finally { await f.stop(); }
});
it('rejects unauthorized audio before download or error reply', async () => {
  const f = await fixture({ allowlist: ['2'] });
  try {
    await f.bot.handleUpdate(f.update()); await voiceQueue.idle();
    expect(f.download).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  } finally { await f.stop(); }
});
it('deduplicates a Telegram delivery without losing a different user', async () => {
  const f = await fixture();
  try {
    const update = f.update(); await f.bot.handleUpdate(update); await f.bot.handleUpdate(update); await f.bot.handleUpdate(f.update(2)); await voiceQueue.idle();
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls.map(c => c[0].user?.userId)).toEqual(['alice', 'bob']);
  } finally { await f.stop(); }
});
it('keeps text and /stop responsive and discards a late transcript', async () => {
  const f = await fixture(); let release!: () => void;
  vi.mocked(transcribeLocalVoice).mockImplementationOnce(async () => {
    await new Promise<void>(r => { release = r; }); return { text: 'late', durationSec: 1, conversionMs: 1, inferenceMs: 1 };
  });
  try {
    await f.bot.handleUpdate(f.update());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const text = f.update(); delete text.message!.voice; Object.assign(text.message!, { text: 'hello' });
    await f.bot.handleUpdate(text); expect(f.publish).toHaveBeenCalledOnce();
    const stop = f.update(); delete stop.message!.voice; Object.assign(stop.message!, { text: '/stop' });
    await f.bot.handleUpdate(stop); release(); await voiceQueue.idle();
    expect(f.publish).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalled();
  } finally { release?.(); await f.stop(); }
});
it('reports missing local configuration without downloading', async () => {
  const f = await fixture(); vi.mocked(checkLocalVoice).mockRejectedValueOnce(new Error('Cannot access voice.local.modelPath; check installation'));
  try {
    await f.bot.handleUpdate(f.update()); await voiceQueue.idle();
    expect(f.download).not.toHaveBeenCalled(); expect(f.send.mock.calls[0][0].text).toContain('modelPath');
  } finally { await f.stop(); }
});
it('does not expose external error details in status replies', async () => {
  const f = await fixture(); vi.mocked(transcribeLocalVoice).mockRejectedValueOnce(new Error('SECRET recorded speech'));
  try {
    await f.bot.handleUpdate(f.update()); await voiceQueue.idle();
    expect(f.send.mock.calls[0][0].text).not.toContain('SECRET'); expect(f.publish).not.toHaveBeenCalled();
  } finally { await f.stop(); }
});
