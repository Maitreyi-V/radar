import { db } from '../db/index.js';
import crypto from 'node:crypto';
import { noveltyKey, type ScoredEvent } from '../significance/score.js';
import type { DetectedEvent } from '../significance/types.js';

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

/** Only prior visits in THIS watchlist count. Current-window refreshes cannot
 * damp themselves. Legacy symbol-only exposure rows have no attributable event
 * types, so their empty event_keys deliberately apply no penalty.
 */
export function recentDigestEventKeys(watchlistId: string, before?: number, buckets = 3): string[][] {
  if (before === undefined) return [];
  const rows = db.prepare(`SELECT event_keys FROM digest_exposures
    WHERE watchlist_id = ? AND shown_at < ? ORDER BY shown_at DESC LIMIT ?`)
    .all(watchlistId, before, buckets) as Array<{ event_keys: string }>;
  return rows.map((row) => JSON.parse(row.event_keys) as string[]);
}

/** Store event types actually displayed, including supporting events on top cards.
 * Multiple occurrences and refreshes within one checkpoint window count once.
 */
export const recordDigestExposure = db.transaction((
  watchlistId: string, checkpointId: string, at: number,
  events: Array<Pick<DetectedEvent, 'symbol' | 'type'>>,
): void => {
  const prior = db.prepare(`SELECT symbols, event_keys FROM digest_exposures WHERE watchlist_id = ? AND checkpoint_id = ?`)
    .get(watchlistId, checkpointId) as { symbols: string; event_keys: string } | undefined;
  const symbols = [...new Set([...(prior ? JSON.parse(prior.symbols) as string[] : []), ...events.map((e) => e.symbol)])];
  const keys = [...new Set([...(prior ? JSON.parse(prior.event_keys) as string[] : []), ...events.map(noveltyKey)])];
  db.prepare(`INSERT INTO digest_exposures (watchlist_id, checkpoint_id, shown_at, symbols, event_keys) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(watchlist_id, checkpoint_id) DO UPDATE SET symbols = excluded.symbols, event_keys = excluded.event_keys`)
    .run(watchlistId, checkpointId, at, JSON.stringify(symbols), JSON.stringify(keys));
});

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
