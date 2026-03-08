import type { Tool, RequestContext } from '../types.js';
import type { InviteStore } from '../../invites/invite-store.js';

/**
 * Invite tool — generates Telegram invite links for new users.
 * Only existing (authorized) users can request invites.
 */
export class InviteTool implements Tool {
  name = 'invite';
  description = 'Generate a Telegram invite link. Send this link to someone so they can start chatting with Janus. The link expires after 24 hours.';
  parameters = {
    type: 'object',
    properties: {},
    required: [],
  };

  private inviteStore: InviteStore;

  constructor(inviteStore: InviteStore) {
    this.inviteStore = inviteStore;
  }

  async execute(_args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string> {
    const userId = reqCtx?.userId ?? 'unknown';
    const { link } = this.inviteStore.create(userId);
    return `Invite link created (valid for 24 hours):\n${link}`;
  }
}
