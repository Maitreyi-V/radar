import { db } from '../db/index.js';
import type { Quote } from './types.js';
import { sessionDate } from './marketCalendar.js';
import type { Bar } from '../significance/stats.js';
import type { DetectedEvent, SymbolContext } from '../significance/types.js';
import { detectVolumeSpike, detectBreach52w, detectGapOpen, detectStreak } from '../significance/detectors.js';

// This file is the "projection" half of the design: as each quote arrives we fold it into a
// per-session summary and a set of market-wide events, ONCE. The alternative — recomputing
// everything when a user opens their digest — would redo the same work per user per request
// and, worse, would compute today's events against whatever data happened to exist by then.

// Real market data and demo replay data live in the same tables but are never mixed. Every
// query below is keyed on stream, so a demo can't pollute or resolve real market history.
export type Stream = 'market' | 'replay';
export const streamOf = (source: string): Stream => source === 'replay' ? 'replay' : 'market';
// SQL columns aliased to the camelCase field names of Quote, so a row maps straight onto the
// type with no hand-written conversion step to drift out of sync.
export const quoteColumns = `symbol, price, volume, day_high AS dayHigh, day_low AS dayLow,
  day_open AS dayOpen, prev_close AS prevClose, week52_high AS week52High,
  week52_low AS week52Low, as_of AS asOf, market_as_of AS marketAsOf,
  fetched_at AS fetchedAt, source, is_synthetic AS isSynthetic`;

export function barsBefore(symbol: string, date: string): Bar[] {
  // `bar_date < ?` — strictly before today. Today's own bar must never be in the baseline
  // we measure today against. DESC + LIMIT 252 takes the most recent year, then .reverse()
  // flips it to oldest-first, which is the order every stats function expects.
  return (db.prepare(`SELECT bar_date AS date, open, high, low, close, volume FROM daily_bars
    WHERE symbol = ? AND bar_date < ? ORDER BY bar_date DESC LIMIT 252`).all(symbol, date) as Bar[]).reverse();
}

// One row per stock per session. The *_quote fields hold whole quotes as JSON strings rather
// than loose columns, so "what did the open actually look like" stays a complete record.
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
// Note `bars` is absent from the DO UPDATE list: the day's historical baseline is written
// once on the first tick and then frozen, so every event in a session is judged against the
// same history. Letting it drift mid-session would make results depend on poll timing.
const eventFor = db.prepare(`SELECT payload FROM market_events WHERE stream = ? AND dedup_key = ?`);
const saveEvent = db.prepare(`INSERT INTO market_events (stream, symbol, dedup_key, occurred_at, peak_at, payload)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (stream, dedup_key) DO UPDATE SET
  occurred_at=excluded.occurred_at, peak_at=excluded.peak_at, payload=excluded.payload`);
// market_events holds the CURRENT best version of an event; market_event_versions keeps every
// version we ever saw. That history is what lets a user who logs in at 2pm see the event as
// it stood at 2pm, rather than the final end-of-day form. See marketEvents() below.
const saveVersion = db.prepare(`INSERT INTO market_event_versions (stream, dedup_key, observed_at, payload)
  VALUES (?, ?, ?, ?) ON CONFLICT (stream, dedup_key, observed_at) DO UPDATE SET payload=excluded.payload`);

/** Called in the SAME transaction as inserting an accepted quote. Never per user. */
export function projectQuote(q: Quote): void {
  const stream = streamOf(q.source);
  // marketAsOf first: during a replay we want the session the data BELONGS to, not the
  // wall-clock session we happen to be replaying it in.
  const date = sessionDate(q.marketAsOf ?? q.asOf);
  const previous = summaryFor.get(stream, q.symbol, date) as SessionSummary | undefined;
  // Reuse the frozen baseline if this session already has one; only hit the bars table on
  // the very first tick of the day. Cheaper, and guarantees a stable baseline.
  const bars: Bar[] = previous ? JSON.parse(previous.bars) : barsBefore(q.symbol, date);
  const json = JSON.stringify(q);
  // `previous && JSON.parse(...)` short-circuits: if previous is undefined the whole
  // expression is undefined, which is exactly the "first tick of the day" case.
  const high: Quote | undefined = previous && JSON.parse(previous.high_quote);
  const low: Quote | undefined = previous && JSON.parse(previous.low_quote);
  // Every field below is written as a running fold over the session: take what we had,
  // combine with this tick. That's what makes it order-independent and replay-safe.
  saveSummary.run({
    stream, symbol: q.symbol, session_date: date,
    first_at: Math.min(previous?.first_at ?? q.asOf, q.asOf),   // `?.` reads the field only if previous exists
    last_at: Math.max(previous?.last_at ?? q.asOf, q.asOf),
    // Open only moves if this tick is genuinely EARLIER than what we called the open —
    // which happens when a provider backfills a tick we missed at the bell.
    open_quote: !previous || q.asOf < previous.first_at ? json : previous.open_quote,
    high_quote: !high || q.price > high.price ? json : previous!.high_quote,
    low_quote: !low || q.price < low.price ? json : previous!.low_quote,
    latest_quote: !previous || q.asOf >= previous.last_at ? json : previous.latest_quote,
    // A null volume means "not reported", which must not overwrite a real number we already
    // have — so we keep the previous max rather than treating the gap as a zero.
    max_volume: q.volume === null ? previous?.max_volume ?? null : Math.max(previous?.max_volume ?? 0, q.volume),
    bars: previous?.bars ?? JSON.stringify(bars),   // written once, then carried forward unchanged
  });
  // A Quote already carries price/volume/dayOpen/prevClose/52w, so spreading it and adding
  // the two missing fields gives a complete SymbolContext with no field-by-field copying.
  const ctx: SymbolContext = { ...q, bars, sessionDate: date };
  // Only the market-wide detectors run here. VOLATILITY_MOVE and REF_DRAWDOWN are missing on
  // purpose: both are measured against something personal (the user's checkpoint, their entry
  // price), so they can't be computed once for everybody — they run per user in the digest.
  const events = [detectVolumeSpike(ctx), detectBreach52w(ctx)];
  // These depend on the session open / completed daily bars, not intraday ticks.
  // So they're evaluated once per session rather than on every tick — re-running them all
  // day would just re-derive the same answer from the same frozen inputs.
  if (!previous) events.push(detectStreak(ctx));
  const previousQuote: Quote | undefined = previous && JSON.parse(previous.latest_quote);
  // Run the gap detector on the first tick of the day, and also keep retrying while the feed
  // hasn't yet given us an open or a previous close — otherwise an early incomplete quote
  // would permanently cost us the gap event for that session.
  if (!previousQuote || previousQuote.dayOpen === null || previousQuote.prevClose === null) events.push(detectGapOpen(ctx));
  for (const event of events) {
    if (!event) continue;    // detectors return null when nothing fired — skip, don't store
    // A streak belongs to the last completed session; don't announce it afresh daily.
    // Re-keying it to the last BAR date means an unchanged 5-day streak keeps the same
    // dedup key tomorrow, so the user isn't told the same thing again.
    if (event.type === 'STREAK' && bars.length) {
      event.dedupKey = `${q.symbol}:STREAK:${bars[bars.length - 1]!.date}:${event.magnitude}`;
    }
    const row = eventFor.get(stream, event.dedupKey) as { payload: string } | undefined;
    const prior: DetectedEvent | undefined = row && JSON.parse(row.payload);
    // "Stronger" decides whether this tick's version replaces the stored one. The judgement:
    // an event should be remembered at its PEAK, not at whatever value it happened to hold
    // when we last polled. A stock that spiked 4x volume at noon and faded by close is a
    // 4x-volume event — reporting the faded number would understate what actually happened.
    const stronger = !prior || event.baseScore > prior.baseScore ||
      (event.baseScore === prior.baseScore && Math.abs(event.magnitude) > Math.abs(prior.magnitude)) ||
      // 52-week breaches score a flat 3.0 so the two tests above can never separate them.
      // Multiplying price by magnitude (+1 high / -1 low) makes "further through the level"
      // win in both directions: higher highs beat, and lower lows beat, with one comparison.
      (event.type === 'BREACH_52W' &&
        Number(event.detail.price) * event.magnitude > Number(prior.detail.price) * prior.magnitude);
    // Nothing new to record: not stronger, and not earlier than what we already have.
    if (!stronger && prior && event.occurredAt >= prior.occurredAt) continue;
    // Two different timestamps, both kept on purpose: firstAt is when the event STARTED,
    // which is what recency decay should measure from, while peakAt is when it was at its
    // worst/biggest, which is what the historical version lookup keys on.
    const firstAt = Math.min(prior?.occurredAt ?? event.occurredAt, event.occurredAt);
    const strongest = stronger ? event : prior!;   // `!` — if not stronger we proved prior exists above
    const peakAt = stronger ? q.asOf : Number(prior!.detail.peakAt);
    const saved: DetectedEvent = { ...strongest, occurredAt: firstAt,
      detail: { ...strongest.detail, firstDetectedAt: firstAt, peakAt } };
    const payload = JSON.stringify(saved);
    saveEvent.run(stream, q.symbol, event.dedupKey, firstAt, peakAt, payload);   // current best
    saveVersion.run(stream, event.dedupKey, q.asOf, payload);                    // append to history
  }
}

/** Compact event lookup; historical reads select the last strength known at `until`. */
export function marketEvents(symbol: string, stream: Stream, after: number, until: number): DetectedEvent[] {
  // `occurred_at > after AND <= until` is the window since the user's last checkpoint. Events
  // they've already been shown fall outside it, so the digest is genuinely "what's new".
  const rows = db.prepare(`SELECT dedup_key, peak_at, payload FROM market_events
    WHERE stream = ? AND symbol = ? AND occurred_at > ? AND occurred_at <= ?
    ORDER BY occurred_at, dedup_key`).all(stream, symbol, after, until) as
    Array<{ dedup_key: string; peak_at: number; payload: string }>;
  // flatMap so a branch can return [] and drop the row entirely — a plain map would leave
  // an undefined hole in the array that every caller would then have to filter out.
  return rows.flatMap((row) => {
    // Peak already happened by `until`, so the stored current version IS the right answer.
    if (row.peak_at <= until) return [JSON.parse(row.payload) as DetectedEvent];
    // Otherwise the stored version peaked AFTER the moment we're asking about. Reading it
    // would be hindsight — telling a user at 11am about a spike that only happened at 3pm.
    // So we go to the version history and take the last one observed at or before `until`.
    const version = db.prepare(`SELECT payload FROM market_event_versions
      WHERE stream = ? AND dedup_key = ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT 1`)
      .get(stream, row.dedup_key, until) as { payload: string } | undefined;
    // EDGE CASE: no version that old -> the event hadn't been detected yet at `until`, so it
    // correctly contributes nothing rather than leaking a future event into a past view.
    return version ? [JSON.parse(version.payload) as DetectedEvent] : [];
  });
}

// Resetting a demo wipes only the replay stream. Real market history is untouched, which is
// why the stream column exists in the first place.
export function clearReplayProjections(): void {
  db.prepare(`DELETE FROM market_events WHERE stream = 'replay'`).run();
  db.prepare(`DELETE FROM session_summaries WHERE stream = 'replay'`).run();
}

export function markProjected(id: number): void {
  // A single-row watermark: the highest quote id we've projected. MAX(...) guards against an
  // out-of-order call moving the marker backwards and causing quotes to be projected twice.
  db.prepare(`INSERT INTO projection_progress (name, quote_id) VALUES ('market-v1', ?)
    ON CONFLICT(name) DO UPDATE SET quote_id = MAX(quote_id, excluded.quote_id)`).run(id);
}

/** One-time upgrade/import catch-up, outside digest requests. Atomic and restart-safe. */
// Restart-safe because of the watermark: we only ever process quotes with a higher id than
// the last one we finished, and the transaction means a crash rolls back to a clean point.
export const backfillProjections = db.transaction((): number => {
  const progress = db.prepare(`SELECT quote_id FROM projection_progress WHERE name = 'market-v1'`)
    .get() as { quote_id: number } | undefined;
  const rows = db.prepare(`SELECT id, ${quoteColumns} FROM quotes WHERE id > ? ORDER BY as_of, id`)
    .all(progress?.quote_id ?? 0) as Array<Quote & { id: number }>;   // `?? 0` = never run before
  let max = progress?.quote_id ?? 0;
  // Ordered by as_of so quotes are replayed through the same fold, in the same order, that
  // they would have taken live. Same code path for catch-up and for real time.
  for (const q of rows) { projectQuote(q); max = Math.max(max, q.id); }
  markProjected(max);
  return rows.length;
});

/** Explicit maintenance after historical bars or detector rules change. Quotes stay intact. */
// The point of separating raw quotes from projections: when a detector's thresholds change,
// we throw away every derived event and rebuild from the quotes we never mutated. The raw
// tape is the source of truth; everything else is reproducible from it.
export const rebuildProjections = db.transaction((): number => {
  db.prepare('DELETE FROM market_events').run();
  db.prepare('DELETE FROM session_summaries').run();
  db.prepare(`DELETE FROM projection_progress WHERE name = 'market-v1'`).run();  // reset the watermark
  return backfillProjections();
});

// Runs once at module startup, including CLI consumers. Never from buildDigest().
// Deliberately here and not on the request path: a user opening the app should never pay for
// a catch-up, and two simultaneous requests should never race to do the same backfill.
backfillProjections();
