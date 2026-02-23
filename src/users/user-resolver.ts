import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { JanusConfig, UserProfile } from '../config/schema.js';
import * as log from '../utils/logger.js';

export interface ResolvedUser {
  userId: string;
  name: string;
  identity: { channel: string; channelUserId?: string; channelUsername?: string };
}

/**
 * Resolve an inbound message sender to a configured user profile.
 * Returns null if no users configured (single-user mode) or no match found.
 */
export function resolveUser(
  channel: string,
  channelUserId: string | undefined,
  channelUsername: string | undefined,
  config: JanusConfig,
): ResolvedUser | null {
  if (config.users.length === 0) return null;

  // 1. Match by stable channelUserId first
  if (channelUserId) {
    for (const user of config.users) {
      const identity = user.identities.find(
        i => i.channel === channel && i.channelUserId === channelUserId,
      );
      if (identity) {
        return { userId: user.id, name: user.name, identity };
      }
    }
  }

  // 2. Fallback: match by channelUsername (unstable)
  if (channelUsername) {
    for (const user of config.users) {
      const identity = user.identities.find(
        i => i.channel === channel && i.channelUsername === channelUsername,
      );
      if (identity) {
        log.warn(
          `User "${user.id}" matched by username "${channelUsername}" — configure channelUserId for stability`,
        );
        return { userId: user.id, name: user.name, identity };
      }
    }
  }

  return null;
}

/**
 * Load a user's PROFILE.md file.
 * Default path: ~/.janus/users/{userId}/PROFILE.md
 * Custom path from config profilePath overrides default.
 */
export async function loadProfileMd(userId: string, profilePath?: string): Promise<string | null> {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home && !profilePath) return null;

  const path = profilePath
    ? resolve(profilePath)
    : resolve(home, '.janus', 'users', userId, 'PROFILE.md');

  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Find a UserProfile from config by userId.
 */
export function findUserProfile(userId: string, config: JanusConfig): UserProfile | undefined {
  return config.users.find(u => u.id === userId);
}
