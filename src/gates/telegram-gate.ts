import type { Bot } from 'grammy';
import type { GateCheck, GateService } from './types.js';
import * as log from '../utils/logger.js';

const TIMEOUT_MS = 60_000;

interface PendingGate {
  callbackId: string;
  chatId: string;
  messageId: number;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * TelegramGate — asks the user for confirmation via inline keyboard.
 * Auto-denies after 60s timeout.
 *
 * Registers a single callback_query listener in the constructor to avoid
 * accumulating listeners (grammY throws if listeners are added inside handlers).
 */
export class TelegramGate implements GateService {
  private bot: Bot;
  private chatId: string;
  private pending = new Map<string, PendingGate>();

  constructor(bot: Bot, chatId: string) {
    this.bot = bot;
    this.chatId = chatId;

    // Single listener for all gate confirmations
    this.bot.on('callback_query:data', (ctx) => {
      const data = ctx.callbackQuery?.data;
      if (!data) return;

      // Find matching pending gate by prefix
      for (const [key, gate] of this.pending) {
        if (data.startsWith(gate.callbackId)) {
          this.pending.delete(key);
          clearTimeout(gate.timer);

          const allowed = data.endsWith(':allow');
          ctx.answerCallbackQuery({ text: allowed ? 'Allowed' : 'Denied' }).catch(() => {});
          this.bot.api.editMessageReplyMarkup(gate.chatId, gate.messageId, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
          gate.resolve(allowed);
          return;
        }
      }
    });
  }

  async confirm(check: GateCheck): Promise<boolean> {
    const callbackId = `gate-${Date.now()}`;
    const targetChatId = check.chatId || this.chatId;

    // Friendlier UX for non-dangerous tools (spawn_agent = delegation, not danger)
    const isDangerous = check.tool !== 'spawn_agent';
    const icon = isDangerous ? '⚠' : '🤖';
    const label = isDangerous ? 'Agent wants to run' : 'Subagent task';
    const msg = await this.bot.api.sendMessage(targetChatId, `${icon} ${label}:\n\`${check.action}\``, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: isDangerous ? '✅ Allow' : '👍 OK' , callback_data: `${callbackId}:allow` },
          { text: isDangerous ? '❌ Deny' : '🚫 Cancel', callback_data: `${callbackId}:deny` },
        ]],
      },
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(callbackId)) return;
        this.pending.delete(callbackId);
        this.bot.api.editMessageReplyMarkup(targetChatId, msg.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        log.info('TelegramGate: timed out, auto-denied');
        resolve(false);
      }, TIMEOUT_MS);

      this.pending.set(callbackId, { callbackId, chatId: targetChatId, messageId: msg.message_id, resolve, timer });
    });
  }
}
