import * as readline from 'node:readline';
import type { GateCheck, GateService } from './types.js';

const TIMEOUT_MS = 30_000;

/**
 * CLIGate — asks the user for confirmation via stdin.
 * Auto-denies after 30s timeout.
 */
export class CLIGate implements GateService {
  async confirm(check: GateCheck): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        rl.close();
        console.log('\nGate: timed out, auto-denied.');
        resolve(false);
      }, TIMEOUT_MS);

      rl.question(`\n⚠ Agent wants to run: ${check.action}\n  Allow? [y/N] `, (answer) => {
        clearTimeout(timer);
        rl.close();
        const allowed = answer.trim().toLowerCase();
        resolve(allowed === 'y' || allowed === 'yes');
      });
    });
  }
}
