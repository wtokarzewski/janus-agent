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
import { acquireInstanceLock, releaseInstanceLock } from '../utils/instance-lock.js';
import { withTimeout } from '../utils/with-timeout.js';
import { buildUpdateStamp, formatCommitList } from '../utils/update-stamp.js';
import { autoUpdateDisabled } from '../utils/auto-update-switch.js';
import { resolveUserTargets } from '../utils/notify-owner.js';
import * as log from '../utils/logger.js';

/** After abort, give teardown this long before force-exiting the process. */
const SHUTDOWN_FORCE_EXIT_MS = 15_000;

export async function runGateway(opts?: { tokenDebug?: boolean }): Promise<void> {
  const config = await loadConfig();

  const { hasAnyProvider } = await import('../config/config.js');
  if (!hasAnyProvider(config.resolved)) {
    console.error('Error: No API key found. Set OPENROUTER_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or GROQ_API_KEY (or use a subscription/OAuth provider).');
    process.exit(1);
  }

  if (process.argv.includes('--debug') || process.argv.includes('-d')) {
    log.setLogLevel('debug');
  }
  if (opts?.tokenDebug || process.argv.includes('--token-debug')) {
    log.enableTokenDebug();
  }

  // Single-instance lock. Two gateways on one workspace share the cron table:
  // whichever polls first claims each job, and if that instance is half-dead
  // its runs are silently lost. Refuse to start alongside a live gateway.
  const lock = await acquireInstanceLock(config.workspace.dir);
  if (!lock.acquired) {
    console.error(`Error: another Janus gateway (pid ${lock.holderPid}) is already running for this workspace.`);
    console.error('Stop it first (or delete .janus/gateway.pid if the pid is wrong).');
    process.exit(1);
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
    // Backstop: if teardown hangs (stuck timer, wedged await), force-exit so
    // the process can't linger as a half-dead instance that still owns cron.
    const forceExit = setTimeout(() => {
      log.error(`Shutdown did not complete within ${SHUTDOWN_FORCE_EXIT_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceExit.unref();
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

      // Initialize bot (fetches bot info once — reused by bot.start(), no duplicate getMe call).
      //
      // grammy retries network failures inside init() forever with a backoff growing to
      // 20 minutes, and never rejects, logging only through the (silenced) `debug` package.
      // A Telegram-side outage therefore used to block the rest of startup indefinitely and
      // in total silence — cron and heartbeat never started, so medication reminders died
      // along with a chat outage they have nothing to do with. Bound the wait instead: on
      // timeout we carry on, and bot.start() keeps retrying in the background.
      const initResult = await withTimeout(bot.init(), config.telegram.initTimeoutMs);
      if (!initResult.ok) {
        const detail = initResult.reason === 'timeout'
          ? `no response within ${Math.round(config.telegram.initTimeoutMs / 1000)}s`
          : initResult.error instanceof Error ? initResult.error.message : String(initResult.error);
        log.warn(`Gateway: Telegram not reachable (${detail}) — continuing without it. Cron and heartbeat start as usual; Telegram reconnects in the background.`);
      }
      // Reading botInfo before a successful init throws, so gate it on the result.
      const botUsername = initResult.ok ? bot.botInfo.username : 'unknown';
      const inviteStore = new InviteStore(botUsername);
      app.tools.register(new InviteTool(inviteStore));

      channelPromises.push(
        tg.start(app.bus, config, signal, bot, { agent: app.agent, subagentRegistry: app.subagentRegistry, inviteStore, database: app.db ?? undefined, llm: app.llm }).catch((err) => {
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
  if (app.cronService && config.autoUpdate.enabled && autoUpdateDisabled(process.env)) {
    log.warn('Gateway: auto-update check skipped — JANUS_NO_AUTO_UPDATE is set. Updates from chat still work.');
  } else if (app.cronService && config.autoUpdate.enabled) {
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
  if (updateMsg && telegramEnabled) {
    // Read the build stamp here, not at update time: this process is the one
    // actually running the new code.
    const stamp = await buildUpdateStamp(config.workspace.dir);
    const commits = formatCommitList(updateMsg);
    // Every user gets it in their DM; group chats are left out of technical notices.
    const userTargets = resolveUserTargets(config);
    const recipients = userTargets.length > 0
      ? userTargets
      : telegramAllowlist.slice(0, 1).map(chatId => ({ channel: 'telegram', chatId }));

    // Small delay so channels have time to initialize
    setTimeout(() => {
      for (const target of recipients) {
        app.bus.publishOutbound({
          chatId: target.chatId,
          channel: target.channel,
          content: `🔄 Janus zaktualizowany i zrestartowany\n${stamp}${commits ? `\n\n${commits}` : ''}`,
          timestamp: new Date(),
        }, signal).catch(err => {
          log.warn(`Gateway: failed to send update notification: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
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
  await stopBrowserRuntime();
  ac.abort();
  await Promise.allSettled([agentPromise, dispatcherPromise]);
  await releaseInstanceLock(config.workspace.dir);

  // Teardown done — exit explicitly. Any leaked timer or open handle would
  // otherwise keep the process alive as a half-dead instance.
  process.exit(0);
}
