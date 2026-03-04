import type { Tool } from '../types.js';

/**
 * heartbeat tool — structured way for the agent to respond to heartbeat/cron checks.
 * Replaces fragile regex-based no-op detection with an explicit tool call.
 * action="skip" returns HEARTBEAT_OK (compatible with existing suppression regex).
 */
export class HeartbeatTool implements Tool {
  name = 'heartbeat';
  description = 'Respond to heartbeat/cron checks. Use action="skip" if nothing needs doing, action="run" to proceed with the task.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['skip', 'run'],
        description: 'Whether to skip (nothing to do) or run (proceed with task).',
      },
      reason: {
        type: 'string',
        description: 'Brief reason for the decision.',
      },
    },
    required: ['action'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? 'skip');
    const reason = args.reason ? String(args.reason) : undefined;

    if (action === 'skip') {
      return reason ? `HEARTBEAT_OK: ${reason}` : 'HEARTBEAT_OK';
    }

    return reason ? `Proceeding with task: ${reason}` : 'Proceeding with task.';
  }
}
