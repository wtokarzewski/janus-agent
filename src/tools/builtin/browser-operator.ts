/**
 * Browser Operator tool — single tool surface for browser automation.
 * Uses real Chrome via extension, not Playwright.
 *
 * Usage: browser({ command: "snapshot", args: {} })
 */

import { randomUUID } from 'node:crypto';
import type { Tool } from '../types.js';
import { BrowserRuntime } from '../../services/browser/browser-runtime.js';
import { checkPolicy } from '../../services/browser/browser-policy.js';
import type { BrowserCommandName } from '../../services/browser/browser-types.js';
import * as log from '../../utils/logger.js';

const VALID_COMMANDS: BrowserCommandName[] = [
  'ping', 'openTab', 'focusTab', 'closeTab', 'navigate', 'getCurrentUrl',
  'snapshot', 'click', 'type', 'pressKey', 'scroll', 'waitFor',
  'extractText', 'screenshot', 'status',
];

// Singleton runtime — shared across tool invocations
let runtime: BrowserRuntime | null = null;

function getRuntime(): BrowserRuntime {
  if (!runtime) {
    runtime = new BrowserRuntime();
  }
  return runtime;
}

export class BrowserOperatorTool implements Tool {
  name = 'browser';
  description = 'Control a real Chrome browser through a dedicated extension. Use for web research, shopping, form filling, and any task requiring real browser interaction. Commands: ping, snapshot, click, type, pressKey, scroll, navigate, openTab, focusTab, closeTab, getCurrentUrl, waitFor, extractText, screenshot, status. The browser uses structured page snapshots — request a snapshot first, then act on element references (e1, e2, etc.). Use status to check runtime diagnostics.';

  parameters = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: VALID_COMMANDS,
        description: 'Browser command to execute.',
      },
      args: {
        type: 'object',
        description: 'Command arguments. Varies by command. Examples: navigate({url}), click({elementId, snapshotVersion}), type({elementId, text, clear}), pressKey({key}), scroll({deltaY}), waitFor({type, ...}).',
      },
    },
    required: ['command'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const cmdArgs = (args.args ?? {}) as Record<string, unknown>;

    if (!VALID_COMMANDS.includes(command as BrowserCommandName)) {
      return `Error: Unknown browser command "${command}". Valid: ${VALID_COMMANDS.join(', ')}`;
    }

    const rt = getRuntime();

    // Status is a read-only diagnostic — no runtime launch or policy check needed
    if (command === 'status') {
      return JSON.stringify(rt.getStatus(), null, 2);
    }

    // Ensure runtime is up (lazy start)
    try {
      await rt.ensureRunning();
    } catch (err) {
      return `Error: Browser runtime failed to start: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Build protocol command
    const browserCommand = {
      id: randomUUID(),
      command: command as BrowserCommandName,
      args: cmdArgs,
    };

    // Policy check
    const policy = checkPolicy(browserCommand);
    if (!policy.allowed) {
      log.info(`Browser policy blocked: ${policy.reason}`);
      return `Error: Blocked by safety policy. ${policy.reason}`;
    }

    // Send to extension
    log.info(`Browser: ${command} ${JSON.stringify(cmdArgs).slice(0, 200)}`);
    const response = await rt.server.send(browserCommand);

    if (!response.ok) {
      const err = response.error;
      const hint = err?.suggestedNextStep ? ` Suggestion: ${err.suggestedNextStep}` : '';
      return `Error: ${err?.message ?? 'Unknown error'} [${err?.code ?? 'unknown'}]${hint}`;
    }

    // Format result for agent
    return JSON.stringify(response.result, null, 2);
  }
}

/** Cleanup runtime on process exit. */
export function stopBrowserRuntime(): void {
  runtime?.stop();
  runtime = null;
}
