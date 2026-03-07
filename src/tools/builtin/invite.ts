import type { ToolContext, ContextualTool } from '../types.js';
import type { InviteStore } from '../../invites/invite-store.js';

/**
 * Invite tool — generates Telegram invite links for new users.
 * Only existing (authorized) users can request invites.
 */
export class InviteTool implements ContextualTool {
  name = 'invite';
  description = 'Generate a Telegram invite link. Send this link to someone so they can start chatting with Janus. The link expires after 24 hours.';
  parameters = {
    type: 'object',
    properties: {},
    required: [],
  };

  private inviteStore: InviteStore;
  private userId = 'unknown';

  constructor(inviteStore: InviteStore) {
    this.inviteStore = inviteStore;
  }

  setContext(ctx: ToolContext): void {
    this.userId = ctx.userId ?? 'unknown';
  }

  async execute(_args: Record<string, unknown>): Promise<string> {
    const { link } = this.inviteStore.create(this.userId);
    return `Invite link created (valid for 24 hours):\n${link}`;
  }
}
