import { db } from '../db/index.js';
import type { Quote, DailyBar } from './types.js';
import { sessionDate } from './marketCalendar.js';
import { resolveConflict, unconfirmed } from './conflict.js';
import { projectQuote, markProjected } from './projections.js';

// db.prepare() compiles the SQL once at module load, not per call. Beyond speed, the @name
// placeholders mean values are bound by the driver — never string-concatenated into SQL.
const insertQuote = db.prepare(`
  INSERT INTO quotes (symbol, price, volume, day_high, day_low, day_open, prev_close,
                      week52_high, week52_low, as_of, fetched_at, source, is_synthetic, session_date, market_as_of)
  VALUES (@symbol, @price, @volume, @dayHigh, @dayLow, @dayOpen, @prevClose,
          @week52High, @week52Low, @asOf, @fetchedAt, @source, @isSynthetic, @sessionDate, @marketAsOf)
  ON CONFLICT (symbol, as_of, source) DO NOTHING
`);
// The ON CONFLICT line makes re-ingesting the same tick a no-op instead of an error. That's
// what lets a poller retry safely: quotes are append-only facts, and the same fact twice
// is still one fact. (info.changes below is how we tell insert from silent duplicate.)

const latestAsOf = db.prepare(
  `SELECT as_of AS asOf FROM quotes WHERE symbol = ? AND source = ? ORDER BY as_of DESC LIMIT 1`,
);

// Four outcomes, named. The caller logs these, so "disputed" showing up in the logs is a
// feature — it's the conflict policy being visibly exercised rather than failing silently.
export type WriteResult = 'inserted' | 'duplicate' | 'stale' | 'disputed';

const latestAny = db.prepare(`
  SELECT symbol, price, volume, day_high AS dayHigh, day_low AS dayLow, day_open AS dayOpen,
         prev_close AS prevClose, week52_high AS week52High, week52_low AS week52Low,
         as_of AS asOf, fetched_at AS fetchedAt, source, is_synthetic AS isSynthetic
  FROM quotes WHERE symbol = ? AND (source = 'replay') = ? ORDER BY as_of DESC, id DESC LIMIT 1
`);
// `(source = 'replay') = ?` keeps the two worlds apart: replayed demo data must never be
// compared against, or overwrite, real market data. Same table, two sealed streams.

/**
 * Persist a quote.
 *
 * Two guards, in order:
 *
 * 1. Monotonic guard (same source): providers deliver out of order under retries and
 *    load balancing. A tick older than what we already hold for that source is DROPPED,
 *    or the UI flaps backwards in time and the diff engine sees phantom reversals.
 *
 * 2. Conflict policy (different sources): BSE and Yahoo/NSE price the same company on
 *    different exchanges, so near-simultaneous quotes genuinely disagree. See conflict.ts
 *    for the rule. A materially disputed price is NOT stored as current — the symbol is
 *    flagged `unconfirmed` and surfaced, never silently adopted or silently hidden.
 */
// Wrapped in db.transaction so the quote row and the projections it triggers either all
// land or none do. A crash halfway can't leave an event pointing at a quote that isn't there.
export const writeQuote = db.transaction((q: Quote): WriteResult => {
  // `as { asOf: number } | undefined` — the driver returns `unknown`, so we tell TypeScript
  // the shape. The `| undefined` is the honest half: .get() returns nothing on no rows.
  const prev = latestAsOf.get(q.symbol, q.source) as { asOf: number } | undefined;
  if (prev && q.asOf < prev.asOf) return 'stale';  // EDGE CASE: retry delivered an old tick late

  const incumbent = latestAny.get(q.symbol, q.source === 'replay' ? 1 : 0) as Quote | undefined;
  if (incumbent) {
    // SQLite has no booleans — it stores 0/1 — so `!!` coerces the number back to a real
    // boolean before the pure conflict logic sees it. `as any` because the raw row type
    // doesn't know about that column shape yet.
    const verdict = resolveConflict(q, { ...incumbent, isSynthetic: !!(incumbent as any).isSynthetic });
    if (verdict.action === 'keep-unconfirmed') {
      unconfirmed.flag(q.symbol, verdict.reason, verdict.divergencePct ?? 0);
      return 'disputed';        // deliberately not stored as the current price
      // The judgement: a disputed price never enters the table at all. If it did, it would
      // become some later quote's "incumbent" and the bad number would quietly win.
    }
    // Feeds agreeing again clears the flag — but replay data must never resolve a real
    // market dispute, hence the explicit source check.
    if (verdict.unconfirmed === false && q.source !== 'replay') unconfirmed.clear(q.symbol);
    if (verdict.action === 'keep' && q.asOf < incumbent.asOf) return 'stale';
  }

  const info = insertQuote.run({
    symbol: q.symbol, price: q.price, volume: q.volume,
    dayHigh: q.dayHigh, dayLow: q.dayLow, dayOpen: q.dayOpen, prevClose: q.prevClose,
    week52High: q.week52High, week52Low: q.week52Low,
    asOf: q.asOf, fetchedAt: q.fetchedAt, source: q.source,
    isSynthetic: q.isSynthetic ? 1 : 0, sessionDate: sessionDate(q.asOf),  // boolean -> 0/1 for SQLite
    marketAsOf: q.marketAsOf ?? null,   // `??`: undefined isn't a valid SQL value, null is
  });
  // changes > 0 means we really inserted. Only then do we project — re-running detectors on
  // a duplicate would be wasted work, and we'd double-count the same tick.
  if (info.changes > 0) {
    projectQuote(q);                            // fold this tick into today's summary + events
    markProjected(Number(info.lastInsertRowid));  // remember how far projections have got
  }
  return info.changes > 0 ? 'inserted' : 'duplicate';
});

// Daily bars are corrected by exchanges after the fact (adjustments, late trades), so unlike
// quotes these are an UPSERT: the newest version of a given day replaces what we had.
const upsertBar = db.prepare(`
  INSERT INTO daily_bars (symbol, bar_date, open, high, low, close, volume)
  VALUES (@symbol, @date, @open, @high, @low, @close, @volume)
  ON CONFLICT (symbol, bar_date) DO UPDATE SET
    open=excluded.open, high=excluded.high, low=excluded.low,
    close=excluded.close, volume=excluded.volume
`);

// One transaction for the whole batch: a backfill of 250 bars is one disk sync instead of
// 250, and a failure part-way leaves no half-written history for the sigma maths to read.
export const writeDailyBars = db.transaction((bars: DailyBar[]) => {
  for (const b of bars) upsertBar.run(b);
  return bars.length;
});

const upsertSymbol = db.prepare(
  `INSERT INTO symbols (symbol, name, exchange) VALUES (?, ?, 'NSE')
   ON CONFLICT (symbol) DO UPDATE SET name = excluded.name`,
);
export const writeSymbols = db.transaction((rows: Array<{ symbol: string; name: string }>) => {
  for (const r of rows) upsertSymbol.run(r.symbol, r.name);   // companies do get renamed
});

export function latestQuote(symbol: string): Quote | undefined {
  // Prepared inline rather than at module scope because this is a read on the request path
  // and the driver caches it anyway; keeping it here keeps the column list next to its use.
  const row = db.prepare(`
    SELECT symbol, price, volume, day_high AS dayHigh, day_low AS dayLow, day_open AS dayOpen,
           prev_close AS prevClose, week52_high AS week52High, week52_low AS week52Low,
           as_of AS asOf, market_as_of AS marketAsOf, fetched_at AS fetchedAt, source, is_synthetic AS isSynthetic
    FROM quotes WHERE symbol = ? ORDER BY as_of DESC LIMIT 1
  `).get(symbol) as any;
  if (!row) return undefined;   // EDGE CASE: symbol we've never fetched -> undefined, not a fake zero quote
  return { ...row, isSynthetic: !!row.isSynthetic } as Quote;  // 0/1 back to a real boolean
}

export function quoteCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM quotes`).get() as { n: number }).n;
}
