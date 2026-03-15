/**
 * Gateway command — headless mode for running Janus as a background service.
 * Starts agent loop + enabled channels (Telegram, etc.) without interactive CLI.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, watchConfig } from '../config/config.js';
import { stopBrowserRuntime } from '../tools/builtin/browser-operator.js';
import { createApp } from '../bootstrap.js';
import { Bot } from 'grammy';
import { TelegramChannel } from '../channels/telegram-channel.js';
import { HeartbeatService } from '../services/heartbeat-service.js';
import { PatternGate } from '../gates/pattern-gate.js';
import { TelegramGate } from '../gates/telegram-gate.js';
import { consumeUpdateMarker } from '../tools/builtin/self-update.js';
import { InviteStore } from '../invites/invite-store.js';
import { InviteTool } from '../tools/builtin/invite.js';
import { deriveChannelAllowlist } from '../users/user-resolver.js';
import * as log from '../utils/logger.js';

export async function runGateway(): Promise<void> {
  const config = await loadConfig();

  const isSubscription = ['claude-agent', 'codex'].includes(config.llm.provider);
  const isOAuth = config.llm.auth === 'oauth';
  if (!isSubscription && !isOAuth && !config.llm.apiKey) {
    console.error('Error: No API key found. Set OPENROUTER_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or GROQ_API_KEY (or use a subscription/OAuth provider).');
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

  let shuttingDown = false;
  const gracefulShutdown = () => {
    if (shuttingDown) { process.exit(1); return; }
    shuttingDown = true;
    console.log('\nShutting down gateway...');
    app.agent.flushAllSessions()
      .catch(err => log.warn(`Shutdown flush failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => ac.abort());
  };
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  // Start agent loop + dispatcher
  const agentPromise = app.agent.run(signal);
  const dispatcherPromise = app.bus.startDispatcher(signal);

  // Start enabled channels
  const channelPromises: Promise<void>[] = [];
  let channelsAttempted = 0;

  // Derive telegram allowlist + enabled from config.users when explicit config is empty
  const telegramAllowlist = config.telegram.allowlist.length > 0
    ? config.telegram.allowlist
    : deriveChannelAllowlist('telegram', config);
  const telegramEnabled = config.telegram.enabled || telegramAllowlist.length > 0;

  if (telegramEnabled) {
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
      if (config.gates.enabled && telegramAllowlist.length > 0) {
        const patternGate = new PatternGate(config.gates.execPatterns);
        const telegramGate = new TelegramGate(bot, telegramAllowlist[0]);
        app.tools.setGate(patternGate, telegramGate);
        app.agent.setGateService(telegramGate);
      }

      // Initialize bot (fetches bot info once — reused by bot.start(), no duplicate getMe call)
      try {
        await bot.init();
      } catch (err) {
        log.error(`Gateway: bot.init() failed: ${err instanceof Error ? err.message : err}`);
      }
      const botUsername = bot.botInfo?.username ?? 'unknown';
      const inviteStore = new InviteStore(botUsername);
      app.tools.register(new InviteTool(inviteStore));

      channelPromises.push(
        tg.start(app.bus, config, signal, bot, { agent: app.agent, subagentRegistry: app.subagentRegistry, inviteStore }).catch((err) => {
          log.error(`Gateway: Telegram channel failed: ${err instanceof Error ? err.message : err}`);
        }),
      );
    }
  }

  if (channelsAttempted === 0) {
    console.error('Error: No channels enabled. Enable at least one channel in janus.json (e.g. telegram.enabled or users with telegram identities).');
    process.exit(1);
  }

  // Start cron service (persistent scheduler)
  if (app.cronService) {
    log.info('Gateway: starting Cron service...');
    app.cronService.start(signal);
  }

  // Start heartbeat service if enabled, HEARTBEAT.md exists, or any per-user HEARTBEAT.md exists
  const heartbeatFileExists = existsSync(resolve(config.workspace.dir, 'HEARTBEAT.md'));
  const hasPerUserHeartbeat = config.users.some(u =>
    existsSync(resolve(config.workspace.dir, '.janus', 'users', u.id, 'HEARTBEAT.md')),
  );
  if (config.heartbeat.enabled || heartbeatFileExists || hasPerUserHeartbeat) {
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

  // Register auto-update check cron (if enabled in config)
  if (app.cronService && config.autoUpdate.enabled) {
    app.cronService.upsertByName({
      name: 'self_update:check',
      scheduleKind: 'cron',
      scheduleValue: config.autoUpdate.schedule,
      task: 'Check for Janus updates using the self_update tool with action "check". If updates are available, report what changed.',
      enabled: true,
    });
    log.info(`Gateway: auto-update check registered (${config.autoUpdate.schedule})`);
  }

  // Post-update notification — if we just restarted after an update
  const updateMsg = consumeUpdateMarker(config.workspace.dir);
  if (updateMsg && telegramEnabled && telegramAllowlist.length > 0) {
    const targetChatId = telegramAllowlist[0];
    // Small delay so channels have time to initialize
    setTimeout(() => {
      app.bus.publishOutbound({
        chatId: targetChatId,
        channel: 'telegram',
        content: `Updated and restarted successfully.\n\n${updateMsg}`,
        timestamp: new Date(),
      }, signal).catch(err => {
        log.warn(`Gateway: failed to send update notification: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 3000);
  }

  // Watch config files for hot reload (I1)
  const stopWatching = watchConfig(config, (newConfig) => {
    log.info(`Gateway: config reloaded (model: ${newConfig.llm.model})`);
  });
  signal.addEventListener('abort', stopWatching);

  console.log('Gateway running. Press Ctrl+C to stop.');

  // Wait for all channels to finish (they block until abort)
  const results = await Promise.allSettled(channelPromises);

  // If all channels failed immediately, shut down
  const allFailed = results.every(r => r.status === 'rejected');
  if (allFailed && !signal.aborted) {
    log.error('Gateway: all channels failed, shutting down');
  }

  await app.agent.flushAllSessions();
  stopBrowserRuntime();
  ac.abort();
  await Promise.allSettled([agentPromise, dispatcherPromise]);
}
