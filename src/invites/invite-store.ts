import { randomBytes } from 'node:crypto';
import * as log from '../utils/logger.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PendingInvite {
  token: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * InviteStore — manages invite tokens for Telegram onboarding.
 *
 * Flow:
 * 1. Existing user asks agent to generate an invite
 * 2. Agent calls createInvite() → returns a deep link
 * 3. New user clicks link → Telegram sends /start invite_TOKEN
 * 4. telegram-channel calls redeem() → validates and removes token
 */
export class InviteStore {
  private pending = new Map<string, PendingInvite>();
  private botUsername: string;
  private ttlMs: number;

  constructor(botUsername: string, ttlMs = DEFAULT_TTL_MS) {
    this.botUsername = botUsername;
    this.ttlMs = ttlMs;
  }

  /** Create a new invite token and return the deep link. */
  create(invitedBy: string): { token: string; link: string } {
    this.cleanup();
    const token = randomBytes(12).toString('base64url');
    const now = Date.now();

    this.pending.set(token, {
      token,
      invitedBy,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });

    const link = `https://t.me/${this.botUsername}?start=invite_${token}`;
    log.info(`Invite created by ${invitedBy}: ${token}`);
    return { token, link };
  }

  /** Redeem an invite token. Returns invitedBy if valid, null if expired/invalid. */
  redeem(token: string): string | null {
    this.cleanup();
    const invite = this.pending.get(token);
    if (!invite) return null;

    this.pending.delete(token);
    log.info(`Invite redeemed: ${token} (invited by ${invite.invitedBy})`);
    return invite.invitedBy;
  }

  /** Remove expired tokens. */
  private cleanup(): void {
    const now = Date.now();
    for (const [token, invite] of this.pending) {
      if (now > invite.expiresAt) {
        this.pending.delete(token);
      }
    }
  }
}
