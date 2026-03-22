import { readFile } from 'node:fs/promises';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { JanusConfig, UserProfile } from '../config/schema.js';
import * as log from '../utils/logger.js';

/** Track which user/chat/agent dirs we've already ensured this process lifetime. */
const ensuredUsers = new Set<string>();
const ensuredChats = new Set<string>();
const ensuredAgents = new Set<string>();

/** Sanitize chatId for filesystem use (Telegram group IDs can be negative, forum topics use '/'). */
export function sanitizeChatId(chatId: string): string {
  return chatId.replace(/\//g, '_');
}

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
        ensureUserDir(user.id, user.name, config.workspace.dir);
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
        ensureUserDir(user.id, user.name, config.workspace.dir);
        return { userId: user.id, name: user.name, identity };
      }
    }
  }

  return null;
}

/**
 * Auto-identify a user from channel metadata when no config.users match exists.
 * Returns a synthetic ResolvedUser with ID like "telegram:123456789".
 */
export function autoIdentifyUser(
  channel: string,
  channelUserId: string | undefined,
  channelUsername: string | undefined,
  displayName: string | undefined,
  workspaceDir?: string,
): ResolvedUser | null {
  if (!channelUserId) return null;
  const userId = `${channel}:${channelUserId}`;
  const name = displayName || channelUsername || channelUserId;
  if (workspaceDir) ensureUserDir(userId, name, workspaceDir);
  return {
    userId,
    name,
    identity: { channel, channelUserId, channelUsername },
  };
}

/**
 * Load a user's PROFILE.md file.
 * Default path: {workspaceDir}/.janus/users/{userId}/PROFILE.md
 * Custom path from config profilePath overrides default.
 */
export async function loadProfileMd(userId: string, workspaceDir: string, profilePath?: string): Promise<string | null> {
  const path = profilePath
    ? resolve(profilePath)
    : resolve(workspaceDir, '.janus', 'users', userId, 'PROFILE.md');

  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Derive an allowlist of channelUserIds from config.users for a given channel.
 * Generic — works for any channel (telegram, whatsapp, etc.).
 */
export function deriveChannelAllowlist(channel: string, config: JanusConfig): string[] {
  return config.users
    .flatMap(u => u.identities)
    .filter(i => i.channel === channel && i.channelUserId)
    .map(i => i.channelUserId!);
}

/**
 * Find a UserProfile from config by userId.
 */
export function findUserProfile(userId: string, config: JanusConfig): UserProfile | undefined {
  return config.users.find(u => u.id === userId);
}

/**
 * Ensure per-user directory exists with default PROFILE.md.
 * Non-destructive — never overwrites existing files.
 * Cached per-process so it only runs once per user.
 */
export function ensureUserDir(userId: string, name: string, workspaceDir: string): void {
  const key = `${workspaceDir}:${userId}`;
  if (ensuredUsers.has(key)) return;
  ensuredUsers.add(key);

  const userDir = resolve(workspaceDir, '.janus', 'users', userId);
  const profilePath = resolve(userDir, 'PROFILE.md');
  const filesDir = resolve(userDir, 'files');

  mkdir(userDir, { recursive: true })
    .then(async () => {
      await mkdir(filesDir, { recursive: true });
      await access(profilePath).catch(() =>
        writeFile(profilePath, `# ${name}\n\n## Preferences\n<!-- Auto-updated by Janus when learning your preferences -->\n`, 'utf-8'),
      );
    })
    .catch(err => {
      log.warn(`Failed to ensure user dir for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/**
 * Ensure per-chat directory exists for shared group files.
 * Non-destructive, cached per-process.
 */
export function ensureChatDir(chatId: string, workspaceDir: string): void {
  const safeChatId = sanitizeChatId(chatId);
  const key = `${workspaceDir}:chat:${safeChatId}`;
  if (ensuredChats.has(key)) return;
  ensuredChats.add(key);

  const chatDir = resolve(workspaceDir, '.janus', 'chats', safeChatId, 'files');
  mkdir(chatDir, { recursive: true }).catch(err => {
    log.warn(`Failed to ensure chat dir for ${safeChatId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Ensure per-agent directory exists with memory/ subdirectory.
 * Non-destructive, cached per-process.
 */
export function ensureAgentDir(agentId: string, workspaceDir: string): void {
  const key = `${workspaceDir}:agent:${agentId}`;
  if (ensuredAgents.has(key)) return;
  ensuredAgents.add(key);

  const agentDir = resolve(workspaceDir, '.janus', 'agents', agentId);
  mkdir(agentDir, { recursive: true })
    .then(() => mkdir(resolve(agentDir, 'memory'), { recursive: true }))
    .catch(err => {
      log.warn(`Failed to ensure agent dir for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    });
}
