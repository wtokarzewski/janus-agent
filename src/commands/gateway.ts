/**
 * Gateway command — headless mode for running Janus as a background service.
 * Starts agent loop + enabled channels (Telegram, etc.) without interactive CLI.
 */

import { loadConfig } from '../config/config.js';
import { createApp } from '../bootstrap.js';
import { Bot } from 'grammy';
import { TelegramChannel } from '../channels/telegram-channel.js';
import { HeartbeatService } from '../services/heartbeat-service.js';
import { PatternGate } from '../gates/pattern-gate.js';
import { TelegramGate } from '../gates/telegram-gate.js';
import * as log from '../utils/logger.js';

export async function runGateway(): Promise<void> {
  const config = await loadConfig();

  const apiKey = config.llm.apiKey;
  if (!apiKey) {
    console.error('Error: No API key found. Set OPENROUTER_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or GROQ_API_KEY.');
    process.exit(1);
  }

  if (process.argv.includes('--debug') || process.argv.includes('-d')) {
    log.setLogLevel('debug');
  }

  // Create all dependencies
  const app = await createApp(config);

  // Graceful shutdown
  const ac = new AbortController();
  const { signal } = ac;

  process.on('SIGINT', () => {
    console.log('\nShutting down gateway...');
    ac.abort();
  });
  process.on('SIGTERM', () => ac.abort());

  // Start agent loop + dispatcher
  const agentPromise = app.agent.run(signal);
  const dispatcherPromise = app.bus.startDispatcher(signal);

  // Start enabled channels
  const channelPromises: Promise<void>[] = [];
  let channelsAttempted = 0;

  if (config.telegram.enabled) {
    channelsAttempted++;
    log.info('Gateway: starting Telegram channel...');

    // Create bot externally so we can share it with TelegramGate
    const telegramToken = config.telegram.token;
    if (!telegramToken) {
      log.error('Gateway: Telegram token not configured');
    } else {
      const bot = new Bot(telegramToken);
      const tg = new TelegramChannel();

      // Wire gate for Telegram (use first allowlist entry as default chatId)
      if (config.gates.enabled && config.telegram.allowlist.length > 0) {
        const patternGate = new PatternGate(config.gates.execPatterns);
        const telegramGate = new TelegramGate(bot, config.telegram.allowlist[0]);
        app.tools.setGate(patternGate, telegramGate);
      }

      channelPromises.push(
        tg.start(app.bus, config, signal, bot).catch((err) => {
          log.error(`Gateway: Telegram channel failed: ${err instanceof Error ? err.message : err}`);
        }),
      );
    }
  }

  if (channelsAttempted === 0) {
    console.error('Error: No channels enabled. Enable at least one channel in janus.json (e.g. telegram.enabled: true).');
    process.exit(1);
  }

  // Start cron service (persistent scheduler)
  if (app.cronService) {
    log.info('Gateway: starting Cron service...');
    app.cronService.start(signal);
  }

  // Start heartbeat service if enabled (syncs HEARTBEAT.md to CronService)
  if (config.heartbeat.enabled) {
    log.info('Gateway: starting Heartbeat service...');
    const heartbeat = new HeartbeatService({
      bus: app.bus,
      config,
      workspaceDir: config.workspace.dir,
      cronService: app.cronService ?? undefined,
    });
    heartbeat.start(signal).catch(err => {
      log.error(`Gateway: Heartbeat service failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  console.log('Gateway running. Press Ctrl+C to stop.');

  // Wait for all channels to finish (they block until abort)
  const results = await Promise.allSettled(channelPromises);

  // If all channels failed immediately, shut down
  const allFailed = results.every(r => r.status === 'rejected');
  if (allFailed && !signal.aborted) {
    log.error('Gateway: all channels failed, shutting down');
  }

  ac.abort();
  await Promise.allSettled([agentPromise, dispatcherPromise]);
}
