import { db } from '../db/index.js';
import crypto from 'node:crypto';
import { noveltyKey, type NoveltyIdentity, type ScoredEvent } from '../significance/score.js';

/**
 * Surfaced-event log for the stock drill-down.
 *
 * Shared detection is stored separately in market_events during ingestion, and
 * per-watchlist novelty comes from digest_exposures, never from this global log.
 *
 * A recurrence strengthens the existing row rather than inserting a second one.
 *
 * Strength is compared on ABS(magnitude), NOT on `score`. `score` is the ranked value —
 * already multiplied by recency decay and novelty damping — so a genuinely bigger
 * recurrence routinely carries a LOWER score than its first showing did. Comparing on
 * score would freeze the first reading in place forever and quietly lose the real peak.
 * `magnitude` is the raw signal in its natural unit (sigmas, x-average, percent), which
 * is the only field here that means the same thing on every read.
 */
const insert = db.prepare(`
  INSERT INTO events (id, symbol, type, magnitude, score, occurred_at, detail, dedup_key, updated_at)
  VALUES (@id, @symbol, @type, @magnitude, @score, @occurredAt, @detail, @dedupKey, @updatedAt)
  ON CONFLICT (dedup_key) DO UPDATE SET
    magnitude  = CASE WHEN ABS(excluded.magnitude) > ABS(events.magnitude) THEN excluded.magnitude ELSE events.magnitude END,
    score      = CASE WHEN ABS(excluded.magnitude) > ABS(events.magnitude) THEN excluded.score     ELSE events.score     END,
    detail     = CASE WHEN ABS(excluded.magnitude) > ABS(events.magnitude) THEN excluded.detail    ELSE events.detail    END,
    updated_at = MAX(events.updated_at, excluded.updated_at)
`);

const priorEvent = db.prepare(`SELECT 1 FROM events WHERE dedup_key = ?`);

/** Returns how many were genuinely new (the rest strengthened an existing row).
 *
 * Counted with an explicit lookup rather than `info.changes`: now that the conflict
 * branch is DO UPDATE, `changes` is 1 for a strengthened row too, so reusing it would
 * silently redefine this number from "new" to "touched".
 */
export const recordEvents = db.transaction((events: ScoredEvent[]): number => {
  let inserted = 0;
  for (const e of events) {
    if (priorEvent.get(e.dedupKey) === undefined) inserted++;
    insert.run({
      id: crypto.randomUUID(),
      symbol: e.symbol, type: e.type,
      magnitude: e.magnitude, score: e.score,
      occurredAt: e.occurredAt,
      detail: JSON.stringify({ ...e.detail, explanation: e.explanation }),
      dedupKey: e.dedupKey,
      // Market time, not wall-clock: the same table's occurred_at is market time, and
      // this keeps the write idempotent. Refreshing the digest ten times re-records the
      // same reading with the same timestamp, so MAX() leaves updated_at untouched —
      // only a genuinely later observation moves it.
      updatedAt: e.lastUpdatedAt ?? e.occurredAt,
    });
  }
  return inserted;
});

export interface StoredEvent {
  id: string; symbol: string; type: string; magnitude: number;
  score: number; occurredAt: number; explanation: string;
  /** Last time this event strengthened. Equals occurredAt if it never recurred. */
  updatedAt: number;
  detail: Record<string, unknown>;
}

/** Event timeline for one symbol — powers the drill-down. */
export function eventsForSymbol(symbol: string, since?: number, limit = 40): StoredEvent[] {
  const rows = db.prepare(`
    SELECT id, symbol, type, magnitude, score, occurred_at AS occurredAt,
           updated_at AS updatedAt, detail
    FROM events WHERE symbol = ? AND occurred_at >= ?
    ORDER BY occurred_at DESC LIMIT ?
  `).all(symbol, since ?? 0, limit) as Array<{ id: string; symbol: string; type: string; magnitude: number; score: number; occurredAt: number; updatedAt: number; detail: string }>;

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
 * Keys are session-scoped, so tomorrow's digest reads today's rows as unrelated.
 */
export const recordDigestExposure = db.transaction((
  watchlistId: string, checkpointId: string, at: number,
  events: NoveltyIdentity[],
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
