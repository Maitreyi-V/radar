import type { Digest } from './types.js';

/**
 * Short-lived digest cache.
 *
 * Digests are computed at read time, which is right — users are absent most of the time
 * and computing for absent users is wasted work. But a returning user hammering refresh,
 * or several tabs opening at once, would each pay full price. A 30s TTL absorbs that
 * without making the digest meaningfully stale.
 *
 * Deliberately in-process and tiny: at this scale a shared cache would add a network
 * dependency and a failure mode to save microseconds. The seam is here if it ever needs
 * to become Redis.
 */
const TTL_MS = 30_000;

interface Entry { digest: Digest; at: number }

const store = new Map<string, Entry>();

const key = (userId: string, watchlistId: string, limit: number): string =>
  `${userId}:${watchlistId}:${limit}`;

export function getCached(userId: string, watchlistId: string, limit: number): Digest | null {
  const hit = store.get(key(userId, watchlistId, limit));
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { store.delete(key(userId, watchlistId, limit)); return null; }
  return hit.digest;
}

export function setCached(userId: string, watchlistId: string, limit: number, digest: Digest): void {
  store.set(key(userId, watchlistId, limit), { digest, at: Date.now() });
}

/**
 * Drop a watchlist's cached digests. Called whenever the underlying facts change —
 * a new checkpoint, or the watchlist membership changing — because a cache that
 * outlives its inputs is just a bug with better latency.
 */
export function invalidate(watchlistId: string): void {
  for (const k of [...store.keys()]) if (k.includes(`:${watchlistId}:`)) store.delete(k);
}

export function cacheSize(): number { return store.size; }
