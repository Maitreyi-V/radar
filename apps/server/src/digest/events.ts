import { db } from '../db/index.js';
import crypto from 'node:crypto';
import type { ScoredEvent } from '../significance/score.js';

/** Legacy surfaced-event log for the stock drill-down.
 * Shared detection is stored separately in market_events during ingestion.
 * Per-watchlist novelty is based on digest_exposures, never this global log.
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
  if (before === undefined) return [];
  const rows = db.prepare(`SELECT symbols FROM digest_exposures
    WHERE watchlist_id = ? AND shown_at < ? ORDER BY shown_at DESC LIMIT ?`)
    .all(watchlistId, before, buckets) as Array<{ symbols: string }>;
  return rows.map((row) => JSON.parse(row.symbols) as string[]);
}

/** Refreshes in one checkpoint window count as a single visit. Only top cards count. */
export function recordDigestExposure(watchlistId: string, checkpointId: string, at: number, symbols: string[]): void {
  const prior = db.prepare(`SELECT symbols FROM digest_exposures WHERE watchlist_id = ? AND checkpoint_id = ?`)
    .get(watchlistId, checkpointId) as { symbols: string } | undefined;
  const seen = [...new Set([...(prior ? JSON.parse(prior.symbols) as string[] : []), ...symbols])];
  db.prepare(`INSERT INTO digest_exposures (watchlist_id, checkpoint_id, shown_at, symbols) VALUES (?, ?, ?, ?)
    ON CONFLICT(watchlist_id, checkpoint_id) DO UPDATE SET symbols = excluded.symbols`)
    .run(watchlistId, checkpointId, at, JSON.stringify(seen));
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
