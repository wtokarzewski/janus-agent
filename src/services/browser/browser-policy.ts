/**
 * Browser Operator — safety policy enforcement.
 * Read-only by default. Dangerous actions blocked.
 */

import type { BrowserCommand, PolicyDecision } from './browser-types.js';
import { DANGEROUS_ACTION_TEXT } from './browser-types.js';

/** Check if a browser command is allowed by policy. */
export function checkPolicy(command: BrowserCommand): PolicyDecision {
  // Safe read-only commands — always allowed
  const safeCommands = [
    'ping', 'snapshot', 'getCurrentUrl', 'extractText', 'screenshot',
    'openTab', 'focusTab', 'closeTab', 'scroll', 'waitFor',
  ];
  if (safeCommands.includes(command.command)) {
    return { allowed: true };
  }

  // Navigate — allowed but check URL
  if (command.command === 'navigate') {
    const url = String(command.args?.url ?? '');
    if (url.includes('checkout') || url.includes('payment') || url.includes('cart')) {
      return {
        allowed: false,
        reason: `Navigation to checkout/payment URL blocked: ${url}`,
        requiresConfirmation: true,
      };
    }
    return { allowed: true };
  }

  // Click — check element text against dangerous patterns
  if (command.command === 'click') {
    const elementText = String(command.args?.elementText ?? '').toLowerCase();
    const match = DANGEROUS_ACTION_TEXT.find(d => elementText.includes(d));
    if (match) {
      return {
        allowed: false,
        reason: `Click blocked: element text "${elementText}" matches dangerous pattern "${match}"`,
        requiresConfirmation: true,
      };
    }
    return { allowed: true };
  }

  // Type and pressKey — generally safe
  if (command.command === 'type' || command.command === 'pressKey') {
    return { allowed: true };
  }

  // Unknown command — block by default
  return { allowed: false, reason: `Unknown command: ${command.command}` };
}
