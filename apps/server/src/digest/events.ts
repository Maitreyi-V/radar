import { db } from '../db/index.js';
import crypto from 'node:crypto';
import type { ScoredEvent } from '../significance/score.js';

/**
 * Event persistence.
 *
 * Detected events are written to `events`, where UNIQUE(dedup_key) makes a repeat
 * insert a no-op. That is idempotency BY CONSTRUCTION rather than by careful coding:
 * `TCS:BREACH_52W:2026-09-04` physically cannot be recorded twice, no matter how many
 * code paths compute it or how many requests race.
 *
 * Persisting them buys two things the in-memory version could not:
 *   - a per-symbol event timeline for the drill-down
 *   - the digest history that NOVELTY DAMPING needs. Without stored history, novelty()
 *     had nothing to look back at and silently always returned 1.0.
 */
const insert = db.prepare(`
  INSERT INTO events (id, symbol, type, magnitude, score, occurred_at, detail, dedup_key)
  VALUES (@id, @symbol, @type, @magnitude, @score, @occurredAt, @detail, @dedupKey)
  ON CONFLICT (dedup_key) DO NOTHING
`);

/** Returns how many were genuinely new (the rest were already recorded). */
export const recordEvents = db.transaction((events: ScoredEvent[]): number => {
  let inserted = 0;
  for (const e of events) {
    const info = insert.run({
      id: crypto.randomUUID(),
      symbol: e.symbol, type: e.type,
      magnitude: e.magnitude, score: e.score,
      occurredAt: e.occurredAt,
      detail: JSON.stringify({ ...e.detail, explanation: e.explanation }),
      dedupKey: e.dedupKey,
    });
    if (info.changes > 0) inserted++;
  }
  return inserted;
});

export interface StoredEvent {
  id: string; symbol: string; type: string; magnitude: number;
  score: number; occurredAt: number; explanation: string;
  detail: Record<string, unknown>;
}

/** Event timeline for one symbol — powers the drill-down. */
export function eventsForSymbol(symbol: string, since?: number, limit = 40): StoredEvent[] {
  const rows = db.prepare(`
    SELECT id, symbol, type, magnitude, score, occurred_at AS occurredAt, detail
    FROM events WHERE symbol = ? AND occurred_at >= ?
    ORDER BY occurred_at DESC LIMIT ?
  `).all(symbol, since ?? 0, limit) as Array<{ id: string; symbol: string; type: string; magnitude: number; score: number; occurredAt: number; detail: string }>;

  return rows.map((r) => {
    const detail = safeParse(r.detail);
    const { explanation, ...rest } = detail;
    return { ...r, explanation: typeof explanation === 'string' ? explanation : '', detail: rest };
  });
}

/**
 * The symbols surfaced in the user's recent digests, newest first — the input novelty
 * damping needs.
 *
 * `before` MUST be the current checkpoint. Novelty exists to damp stocks that were noisy
 * in PREVIOUS visits; events from the window being computed right now are this visit's
 * news and must not damp themselves. Without that bound the digest is not idempotent:
 * viewing it records its own events, and the next refresh scores those same stocks 0.7x,
 * so cards silently drop out on reload — observed live, 4 cards becoming 3.
 */
export function recentDigestSymbols(watchlistId: string, before?: number, buckets = 3): string[][] {
  const cutoff = before ?? Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`
    SELECT DISTINCT e.symbol, e.occurred_at AS occurredAt
    FROM events e
    WHERE e.symbol IN (SELECT symbol FROM watchlist_items WHERE watchlist_id = ?)
      AND e.occurred_at < ?
    ORDER BY e.occurred_at DESC LIMIT 200
  `).all(watchlistId, cutoff) as Array<{ symbol: string; occurredAt: number }>;

  if (rows.length === 0) return [];

  // Group into `buckets` equal time slices spanning the observed history.
  const newest = rows[0]!.occurredAt;
  const oldest = rows[rows.length - 1]!.occurredAt;
  const span = Math.max(1, newest - oldest);
  const out: string[][] = Array.from({ length: buckets }, () => []);

  for (const r of rows) {
    const idx = Math.min(buckets - 1, Math.floor(((newest - r.occurredAt) / span) * buckets));
    if (!out[idx]!.includes(r.symbol)) out[idx]!.push(r.symbol);
  }
  return out;
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
