import type { Bot } from 'grammy';
import type { GateCheck, GateService } from './types.js';
import * as log from '../utils/logger.js';

const TIMEOUT_MS = 60_000;

/**
 * TelegramGate — asks the user for confirmation via inline keyboard.
 * Auto-denies after 60s timeout.
 */
export class TelegramGate implements GateService {
  private bot: Bot;
  private chatId: string;

  constructor(bot: Bot, chatId: string) {
    this.bot = bot;
    this.chatId = chatId;
  }

  async confirm(check: GateCheck): Promise<boolean> {
    const callbackId = `gate-${Date.now()}`;
    const targetChatId = check.chatId || this.chatId;

    const msg = await this.bot.api.sendMessage(targetChatId, `⚠ Agent wants to run:\n\`${check.action}\``, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Allow', callback_data: `${callbackId}:allow` },
          { text: 'Deny', callback_data: `${callbackId}:deny` },
        ]],
      },
    });

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this.bot.api.editMessageReplyMarkup(targetChatId, msg.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        log.info('TelegramGate: timed out, auto-denied');
        resolve(false);
      }, TIMEOUT_MS);

      this.bot.on('callback_query:data', (ctx) => {
        if (resolved) return;
        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith(callbackId)) return;

        resolved = true;
        clearTimeout(timer);

        const allowed = data.endsWith(':allow');
        ctx.answerCallbackQuery({ text: allowed ? 'Allowed' : 'Denied' }).catch(() => {});
        this.bot.api.editMessageReplyMarkup(targetChatId, msg.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        resolve(allowed);
      });
    });
  }
}
