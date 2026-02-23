#!/usr/bin/env tsx
/**
 * Janus — Universal AI Agent
 *
 * Entry point: commander-based CLI with subcommands.
 */

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { runOnboard } from './commands/onboard.js';
import { runGateway } from './commands/gateway.js';
import { loadConfig } from './config/config.js';
import { createApp } from './bootstrap.js';
import { CLIChannel } from './channels/cli-channel.js';
import { PatternGate } from './gates/pattern-gate.js';
import { CLIGate } from './gates/cli-gate.js';
import * as log from './utils/logger.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('janus')
  .description('Universal AI agent — autonomous digital worker for any domain')
  .version(version);

// Default action: interactive CLI or single-message mode
program
  .option('-m, --message <text>', 'Send a single message and exit')
  .option('-d, --debug', 'Enable debug logging')
  .action(async (opts: { message?: string; debug?: boolean }) => {
    if (opts.debug) log.setLogLevel('debug');

    let config = await loadConfig();

    // Launch setup wizard if no provider configured
    const hasProvider = config.llm.apiKey
      || (config.llm.providers && config.llm.providers.length > 0)
      || ['claude-agent', 'codex'].includes(config.llm.provider);

    if (!hasProvider) {
      console.log('\n  No LLM provider configured. Starting setup...\n');
      const { runSetup } = await import('./commands/setup.js');
      await runSetup();
      config = await loadConfig();
    }

    const app = await createApp(config);

    // Gates (confirmation before destructive commands)
    if (config.gates.enabled) {
      const patternGate = new PatternGate(config.gates.execPatterns);
      app.tools.setGate(patternGate, new CLIGate());
    }

    // Single-message mode
    if (opts.message) {
      const result = await app.agent.processDirect(opts.message);
      console.log(result);
      return;
    }

    // Interactive mode
    const ac = new AbortController();
    const { signal } = ac;

    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      ac.abort();
    });
    process.on('SIGTERM', () => ac.abort());

    const agentPromise = app.agent.run(signal);
    const dispatcherPromise = app.bus.startDispatcher(signal);

    const cli = new CLIChannel();
    await cli.start(app.bus, signal);

    ac.abort();
    await Promise.allSettled([agentPromise, dispatcherPromise]);
  });

program
  .command('onboard [dir]')
  .alias('init')
  .description('Initialize workspace (EGO.md, AGENTS.md, config, etc.)')
  .action(async (dir?: string) => {
    await runOnboard(dir);
  });

program
  .command('gateway')
  .description('Run in headless mode (Telegram and other channels)')
  .action(async () => {
    await runGateway();
  });

program
  .command('mcp-server')
  .description('Start MCP server (JSON-RPC over stdio)')
  .action(async () => {
    const { startMcpServer } = await import('./commands/mcp-server.js');
    await startMcpServer();
  });

program
  .command('setup')
  .description('Run the setup wizard to configure LLM provider')
  .action(async () => {
    const { runSetup } = await import('./commands/setup.js');
    await runSetup();
  });

program.parseAsync().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
