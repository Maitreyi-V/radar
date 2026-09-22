import { db } from '../db/index.js';
import type { Quote } from './types.js';
import { sessionDate } from './marketCalendar.js';
import type { Bar } from '../significance/stats.js';
import type { DetectedEvent, SymbolContext } from '../significance/types.js';
import { detectVolumeSpike, detectBreach52w, detectGapOpen, detectStreak } from '../significance/detectors.js';

export type Stream = 'market' | 'replay';
export const streamOf = (source: string): Stream => source === 'replay' ? 'replay' : 'market';
export const quoteColumns = `symbol, price, volume, day_high AS dayHigh, day_low AS dayLow,
  day_open AS dayOpen, prev_close AS prevClose, week52_high AS week52High,
  week52_low AS week52Low, as_of AS asOf, market_as_of AS marketAsOf,
  fetched_at AS fetchedAt, source, is_synthetic AS isSynthetic`;

export function barsBefore(symbol: string, date: string): Bar[] {
  return (db.prepare(`SELECT bar_date AS date, open, high, low, close, volume FROM daily_bars
    WHERE symbol = ? AND bar_date < ? ORDER BY bar_date DESC LIMIT 252`).all(symbol, date) as Bar[]).reverse();
}

export interface SessionSummary {
  stream: Stream; symbol: string; session_date: string; first_at: number; last_at: number;
  open_quote: string; high_quote: string; low_quote: string; latest_quote: string;
  max_volume: number | null; bars: string;
}

const summaryFor = db.prepare(`SELECT * FROM session_summaries WHERE stream = ? AND symbol = ? AND session_date = ?`);
const saveSummary = db.prepare(`INSERT INTO session_summaries
  (stream, symbol, session_date, first_at, last_at, open_quote, high_quote, low_quote, latest_quote, max_volume, bars)
  VALUES (@stream, @symbol, @session_date, @first_at, @last_at, @open_quote, @high_quote, @low_quote, @latest_quote, @max_volume, @bars)
  ON CONFLICT (stream, symbol, session_date) DO UPDATE SET
  first_at=excluded.first_at, last_at=excluded.last_at, open_quote=excluded.open_quote,
  high_quote=excluded.high_quote, low_quote=excluded.low_quote, latest_quote=excluded.latest_quote,
  max_volume=excluded.max_volume`);
const eventFor = db.prepare(`SELECT payload, last_updated_at FROM market_events WHERE stream = ? AND dedup_key = ?`);

/**
 * How much stronger a recurrence must be before it counts as an UPDATE the user
 * deserves to see again.
 *
 * Volume is cumulative: it rises on literally every tick. Without this guard an
 * acknowledged VOLUME_SPIKE would re-qualify on every single poll for the rest of the
 * session, which is precisely the "watchlist that always screams" this product exists
 * to refuse. 25% is deliberately coarse — 4x -> 5x reopens the card, 4.00x -> 4.05x
 * does not. The row still records the latest numbers either way; only the
 * user-facing "this changed" clock is held back.
 */
const MATERIAL_GAIN = 1.25;
const saveEvent = db.prepare(`INSERT INTO market_events (stream, symbol, dedup_key, occurred_at, peak_at, last_updated_at, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (stream, dedup_key) DO UPDATE SET
  occurred_at=excluded.occurred_at, peak_at=excluded.peak_at,
  last_updated_at=excluded.last_updated_at, payload=excluded.payload`);
const saveVersion = db.prepare(`INSERT INTO market_event_versions (stream, dedup_key, observed_at, payload)
  VALUES (?, ?, ?, ?) ON CONFLICT (stream, dedup_key, observed_at) DO UPDATE SET payload=excluded.payload`);

/** Called in the SAME transaction as inserting an accepted quote. Never per user. */
export function projectQuote(q: Quote): void {
  const stream = streamOf(q.source);
  const date = sessionDate(q.marketAsOf ?? q.asOf);
  const previous = summaryFor.get(stream, q.symbol, date) as SessionSummary | undefined;
  const bars: Bar[] = previous ? JSON.parse(previous.bars) : barsBefore(q.symbol, date);
  const json = JSON.stringify(q);
  const high: Quote | undefined = previous && JSON.parse(previous.high_quote);
  const low: Quote | undefined = previous && JSON.parse(previous.low_quote);
  saveSummary.run({
    stream, symbol: q.symbol, session_date: date,
    first_at: Math.min(previous?.first_at ?? q.asOf, q.asOf),
    last_at: Math.max(previous?.last_at ?? q.asOf, q.asOf),
    open_quote: !previous || q.asOf < previous.first_at ? json : previous.open_quote,
    high_quote: !high || q.price > high.price ? json : previous!.high_quote,
    low_quote: !low || q.price < low.price ? json : previous!.low_quote,
    latest_quote: !previous || q.asOf >= previous.last_at ? json : previous.latest_quote,
    max_volume: q.volume === null ? previous?.max_volume ?? null : Math.max(previous?.max_volume ?? 0, q.volume),
    bars: previous?.bars ?? JSON.stringify(bars),
  });
  const ctx: SymbolContext = { ...q, bars, sessionDate: date };
  const events = [detectVolumeSpike(ctx), detectBreach52w(ctx)];
  // These depend on the session open / completed daily bars, not intraday ticks.
  if (!previous) events.push(detectStreak(ctx));
  const previousQuote: Quote | undefined = previous && JSON.parse(previous.latest_quote);
  if (!previousQuote || previousQuote.dayOpen === null || previousQuote.prevClose === null) events.push(detectGapOpen(ctx));
  for (const event of events) {
    if (!event) continue;
    // A streak belongs to the last completed session; don't announce it afresh daily.
    if (event.type === 'STREAK' && bars.length) {
      event.dedupKey = `${q.symbol}:STREAK:${bars[bars.length - 1]!.date}:${event.magnitude}`;
    }
    const row = eventFor.get(stream, event.dedupKey) as { payload: string; last_updated_at: number } | undefined;
    const prior: DetectedEvent | undefined = row && JSON.parse(row.payload);
    const stronger = !prior || event.baseScore > prior.baseScore ||
      (event.baseScore === prior.baseScore && Math.abs(event.magnitude) > Math.abs(prior.magnitude)) ||
      (event.type === 'BREACH_52W' &&
        Number(event.detail.price) * event.magnitude > Number(prior.detail.price) * prior.magnitude);
    // BREACH_52W carries a flat weight, so it can never show a score gain at all — and
    // it only re-fires when the price sets a genuinely NEW extreme. That is a discrete
    // milestone, not a per-tick accumulation, so for it any strengthening is material.
    const material = !prior || (stronger && (
      event.type === 'BREACH_52W' || event.baseScore >= prior.baseScore * MATERIAL_GAIN
    ));
    // Nothing changed: the row is left alone, so last_updated_at deliberately does NOT
    // move. A re-detection that tells us nothing new is not an update.
    if (!stronger && prior && event.occurredAt >= prior.occurredAt) continue;
    const firstAt = Math.min(prior?.occurredAt ?? event.occurredAt, event.occurredAt);
    const strongest = stronger ? event : prior!;
    const peakAt = stronger ? q.asOf : Number(prior!.detail.peakAt);
    // The timestamp the digest tests against the user's checkpoint. Held at its previous
    // value for an immaterial gain, so the payload below still reports the newest numbers
    // without reopening a card the user has already acknowledged.
    const lastUpdatedAt = material ? q.asOf : (row?.last_updated_at ?? q.asOf);
    const saved: DetectedEvent = { ...strongest, occurredAt: firstAt, lastUpdatedAt,
      detail: { ...strongest.detail, firstDetectedAt: firstAt, peakAt } };
    const payload = JSON.stringify(saved);
    saveEvent.run(stream, q.symbol, event.dedupKey, firstAt, peakAt, lastUpdatedAt, payload);
    saveVersion.run(stream, event.dedupKey, q.asOf, payload);
  }
}

/**
 * Compact event lookup; historical reads select the last strength known at `until`.
 *
 * An event is in-window if it STARTED after `after` **or** was last updated after it.
 * The second half is the point: an event first seen at 10:00, checkpointed at 11:00 and
 * strengthened at 12:00 has `occurred_at = 10:00` forever, so an occurred_at-only window
 * hides exactly the thing the user came back to find out.
 */
export function marketEvents(symbol: string, stream: Stream, after: number, until: number): DetectedEvent[] {
  const rows = db.prepare(`SELECT dedup_key, occurred_at, last_updated_at, payload FROM market_events
    WHERE stream = ? AND symbol = ? AND occurred_at <= ?
      AND (occurred_at > ? OR last_updated_at > ?)
    ORDER BY occurred_at, dedup_key`).all(stream, symbol, until, after, after) as
    Array<{ dedup_key: string; occurred_at: number; last_updated_at: number; payload: string }>;
  return rows.flatMap((row) => {
    // The row has not changed since `until`, so what it holds now is what it held then.
    if (row.last_updated_at <= until) return [JSON.parse(row.payload) as DetectedEvent];
    // It changed AFTER the horizon we are reading at. Rewind to the strength known at
    // `until` — and re-test the window against THAT version's timestamp, because the
    // update that qualified this row may not have happened yet at `until`.
    const version = db.prepare(`SELECT observed_at, payload FROM market_event_versions
      WHERE stream = ? AND dedup_key = ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT 1`)
      .get(stream, row.dedup_key, until) as { observed_at: number; payload: string } | undefined;
    if (!version) return [];
    const parsed = JSON.parse(version.payload) as DetectedEvent;
    // Test the window against the payload's OWN clock, not observed_at: a version is
    // written on every strength change, but an immaterial one deliberately did not move
    // lastUpdatedAt. Using observed_at here would let the as-of read resurface something
    // the current read correctly keeps hidden.
    if (row.occurred_at <= after && (parsed.lastUpdatedAt ?? version.observed_at) <= after) return [];
    return [parsed];
  });
}

export function clearReplayProjections(): void {
  db.prepare(`DELETE FROM market_events WHERE stream = 'replay'`).run();
  db.prepare(`DELETE FROM session_summaries WHERE stream = 'replay'`).run();
}

export function markProjected(id: number): void {
  db.prepare(`INSERT INTO projection_progress (name, quote_id) VALUES ('market-v1', ?)
    ON CONFLICT(name) DO UPDATE SET quote_id = MAX(quote_id, excluded.quote_id)`).run(id);
}

/** One-time upgrade/import catch-up, outside digest requests. Atomic and restart-safe. */
export const backfillProjections = db.transaction((): number => {
  const progress = db.prepare(`SELECT quote_id FROM projection_progress WHERE name = 'market-v1'`)
    .get() as { quote_id: number } | undefined;
  const rows = db.prepare(`SELECT id, ${quoteColumns} FROM quotes WHERE id > ? ORDER BY as_of, id`)
    .all(progress?.quote_id ?? 0) as Array<Quote & { id: number }>;
  let max = progress?.quote_id ?? 0;
  for (const q of rows) { projectQuote(q); max = Math.max(max, q.id); }
  markProjected(max);
  return rows.length;
});

/** Explicit maintenance after historical bars or detector rules change. Quotes stay intact. */
export const rebuildProjections = db.transaction((): number => {
  db.prepare('DELETE FROM market_events').run();
  db.prepare('DELETE FROM session_summaries').run();
  db.prepare(`DELETE FROM projection_progress WHERE name = 'market-v1'`).run();
  return backfillProjections();
});

// Runs once at module startup, including CLI consumers. Never from buildDigest().
backfillProjections();
