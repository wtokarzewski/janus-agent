import * as readline from 'node:readline';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import type { MessageBus } from '../bus/message-bus.js';
import type { InboundMessage, OutboundMessage } from '../bus/types.js';
import { randomUUID } from 'node:crypto';
import * as log from '../utils/logger.js';

const EXIT_COMMANDS = new Set(['exit', 'quit', '/exit', '/quit', ':q']);
const HISTORY_FILE = resolve(process.env.HOME || process.env.USERPROFILE || '.', '.janus', 'history');
const MAX_HISTORY = 500;

/**
 * CLI Channel — interactive REPL via stdin/stdout.
 * Registers as outbound handler in MessageBus for proper routing.
 */
export class CLIChannel {
  name = 'cli';
  private rl?: readline.Interface;

  async start(bus: MessageBus, signal: AbortSignal): Promise<void> {
    // Load persistent history
    const history = await loadHistory();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.green('janus> '),
      history,
      historySize: MAX_HISTORY,
    });

    // Handle readline errors (e.g. stdin closed unexpectedly)
    this.rl.on('error', (err) => {
      log.warn(`CLI readline error: ${err.message}`);
    });

    // Register as outbound handler — dispatcher runs in index.ts
    bus.registerHandler('cli', async (msg: OutboundMessage) => {
      try {
        if (msg.type === 'chunk') {
          process.stdout.write(msg.content);
        } else if (msg.type === 'stream_end') {
          process.stdout.write('\n\n');
          this.rl?.prompt();
        } else {
          // 'message' or undefined — backward compatible
          process.stdout.write('\n' + msg.content + '\n\n');
          this.rl?.prompt();
        }
      } catch (err) {
        log.warn(`CLI stdout write error: ${err instanceof Error ? err.message : err}`);
      }
    });

    // Display welcome
    console.log(chalk.bold('\nJanus AI Agent'));
    console.log(chalk.gray('Type your message, press Enter to send. Type "exit" or Ctrl+C to quit.\n'));
    this.rl.prompt();

    // Input loop
    const chatId = 'default';
    const sessionHistory: string[] = [...history];

    this.rl.on('line', async (line) => {
      const content = line.trim();
      if (!content) {
        this.rl?.prompt();
        return;
      }

      // Exit commands
      if (EXIT_COMMANDS.has(content.toLowerCase())) {
        console.log(chalk.gray('Bye!'));
        this.rl?.close();
        return;
      }

      // /help command — show available commands
      if (content.toLowerCase() === '/help' || content.toLowerCase() === 'help') {
        console.log('');
        console.log(chalk.bold('Commands:'));
        console.log(`  ${chalk.green('/help')}     Show this help`);
        console.log(`  ${chalk.green('/config')}   Reconfigure LLM provider`);
        console.log(`  ${chalk.green('exit')}      Quit (also: quit, /exit, /quit, :q, Ctrl+C)`);
        console.log('');
        console.log(chalk.bold('Tools:'));
        console.log('  exec, read-file, write-file, edit-file, list-dir, message, spawn_agent, cron');
        console.log('');
        console.log(chalk.gray('Type any message to chat with Janus.'));
        console.log('');
        this.rl?.prompt();
        return;
      }

      // /config command — reconfigure LLM provider
      if (content.toLowerCase() === '/config') {
        const { runSetup } = await import('../commands/setup.js');
        await runSetup({ reconfigure: true });
        console.log(chalk.yellow('  Restart Janus to apply changes.\n'));
        this.rl?.prompt();
        return;
      }

      // Track history for persistence
      sessionHistory.push(content);

      const msg: InboundMessage = {
        id: randomUUID(),
        channel: 'cli',
        chatId,
        content,
        author: 'user',
        timestamp: new Date(),
      };

      try {
        await bus.publishInbound(msg, signal);
      } catch {
        // Shutting down
      }
    });

    // Wait for close
    await new Promise<void>((resolveP) => {
      this.rl!.on('close', resolveP);
      signal.addEventListener('abort', () => {
        this.rl?.close();
        resolveP();
      }, { once: true });
    });

    // Save history on exit
    await saveHistory(sessionHistory).catch(() => {});
  }

  stop(): void {
    this.rl?.close();
  }
}

async function loadHistory(): Promise<string[]> {
  try {
    const content = await readFile(HISTORY_FILE, 'utf-8');
    return content.split('\n').filter(Boolean).slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

async function saveHistory(lines: string[]): Promise<void> {
  const dir = resolve(HISTORY_FILE, '..');
  await mkdir(dir, { recursive: true });
  const trimmed = lines.filter(Boolean).slice(-MAX_HISTORY);
  await writeFile(HISTORY_FILE, trimmed.join('\n') + '\n', 'utf-8');
}
