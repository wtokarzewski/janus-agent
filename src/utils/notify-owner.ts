import type { MessageBus } from '../bus/message-bus.js';
import * as log from './logger.js';

interface OwnerIdentity {
  channel: string;
  channelUserId?: string;
  channelUsername?: string;
}

interface OwnerUser {
  id: string;
  identities: OwnerIdentity[];
}

export interface OwnerTarget {
  channel: string;
  chatId: string;
}

/**
 * Where to reach the owner with an operational alert.
 *
 * Owners are config IDs, not chats — resolve them to the channel identities
 * that actually carry a chat ID. A username-only identity is skipped: there is
 * nothing to address a DM to until the user has messaged the bot.
 */
export function resolveOwnerTargets(config: { ownerIds: string[]; users: OwnerUser[] }): OwnerTarget[] {
  const owners = config.ownerIds.length > 0
    ? config.users.filter(u => config.ownerIds.includes(u.id))
    : config.users.slice(0, 1);

  return owners.flatMap(u =>
    u.identities
      .filter(i => !!i.channelUserId)
      .map(i => ({ channel: i.channel, chatId: i.channelUserId! })),
  );
}

/**
 * Every configured user's DM — for announcements the whole household should
 * see, like "the agent just restarted on a new version". Group chats are
 * deliberately excluded: a technical notice belongs to people, not rooms.
 */
export function resolveUserTargets(config: { users: OwnerUser[] }): OwnerTarget[] {
  return config.users.flatMap(u =>
    u.identities
      .filter(i => !!i.channelUserId)
      .map(i => ({ channel: i.channel, chatId: i.channelUserId! })),
  );
}

/**
 * Push an operational alert to the owner's DM. Best effort: a failure here
 * must never take down the caller, which is usually a background timer.
 */
export function notifyOwners(
  bus: MessageBus,
  config: { ownerIds: string[]; users: OwnerUser[] },
  content: string,
): void {
  const targets = resolveOwnerTargets(config);
  if (targets.length === 0) {
    log.warn('Owner alert not delivered — no owner identity with a chat ID is configured');
    return;
  }

  for (const target of targets) {
    bus.publishOutbound({
      chatId: target.chatId,
      channel: target.channel,
      content,
      timestamp: new Date(),
      type: 'message',
    }).catch(err => log.warn(`Owner alert failed for ${target.channel}:${target.chatId}: ${err}`));
  }
}
