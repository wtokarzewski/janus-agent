/**
 * Simple in-memory TTL cache for web tools.
 * Shared between web_search (Brave + DDG) and web_fetch.
 */

const DEFAULT_TTL_MS = 15 * 60_000; // 15 minutes
const MAX_ENTRIES = 100;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCache(key: string): string | null {
  const entry = cache.get(key.toLowerCase());
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key.toLowerCase());
    return null;
  }
  return entry.value;
}

export function setCache(key: string, value: string, ttlMs = DEFAULT_TTL_MS): void {
  if (ttlMs <= 0) return;
  // Evict oldest if at capacity
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key.toLowerCase(), { value, expiresAt: Date.now() + ttlMs });
}
