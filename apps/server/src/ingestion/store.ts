import { db } from '../db/index.js';
import type { Quote, DailyBar } from './types.js';
import { sessionDate } from './marketCalendar.js';
import { resolveConflict, unconfirmed } from './conflict.js';

const insertQuote = db.prepare(`
  INSERT INTO quotes (symbol, price, volume, day_high, day_low, day_open, prev_close,
                      week52_high, week52_low, as_of, fetched_at, source, is_synthetic, session_date)
  VALUES (@symbol, @price, @volume, @dayHigh, @dayLow, @dayOpen, @prevClose,
          @week52High, @week52Low, @asOf, @fetchedAt, @source, @isSynthetic, @sessionDate)
  ON CONFLICT (symbol, as_of, source) DO NOTHING
`);

const latestAsOf = db.prepare(
  `SELECT as_of AS asOf FROM quotes WHERE symbol = ? AND source = ? ORDER BY as_of DESC LIMIT 1`,
);

export type WriteResult = 'inserted' | 'duplicate' | 'stale' | 'disputed';

const latestAny = db.prepare(`
  SELECT symbol, price, volume, day_high AS dayHigh, day_low AS dayLow, day_open AS dayOpen,
         prev_close AS prevClose, week52_high AS week52High, week52_low AS week52Low,
         as_of AS asOf, fetched_at AS fetchedAt, source, is_synthetic AS isSynthetic
  FROM quotes WHERE symbol = ? ORDER BY as_of DESC, id DESC LIMIT 1
`);

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
export function writeQuote(q: Quote): WriteResult {
  const prev = latestAsOf.get(q.symbol, q.source) as { asOf: number } | undefined;
  if (prev && q.asOf < prev.asOf) return 'stale';

  const incumbent = latestAny.get(q.symbol) as Quote | undefined;
  if (incumbent) {
    const verdict = resolveConflict(q, { ...incumbent, isSynthetic: !!(incumbent as any).isSynthetic });
    if (verdict.action === 'keep-unconfirmed') {
      unconfirmed.flag(q.symbol, verdict.reason, verdict.divergencePct ?? 0);
      return 'disputed';        // deliberately not stored as the current price
    }
    if (verdict.unconfirmed === false) unconfirmed.clear(q.symbol);
  }

  const info = insertQuote.run({
    symbol: q.symbol, price: q.price, volume: q.volume,
    dayHigh: q.dayHigh, dayLow: q.dayLow, dayOpen: q.dayOpen, prevClose: q.prevClose,
    week52High: q.week52High, week52Low: q.week52Low,
    asOf: q.asOf, fetchedAt: q.fetchedAt, source: q.source,
    isSynthetic: q.isSynthetic ? 1 : 0, sessionDate: sessionDate(q.asOf),
  });
  return info.changes > 0 ? 'inserted' : 'duplicate';
}

const upsertBar = db.prepare(`
  INSERT INTO daily_bars (symbol, bar_date, open, high, low, close, volume)
  VALUES (@symbol, @date, @open, @high, @low, @close, @volume)
  ON CONFLICT (symbol, bar_date) DO UPDATE SET
    open=excluded.open, high=excluded.high, low=excluded.low,
    close=excluded.close, volume=excluded.volume
`);

export const writeDailyBars = db.transaction((bars: DailyBar[]) => {
  for (const b of bars) upsertBar.run(b);
  return bars.length;
});

const upsertSymbol = db.prepare(
  `INSERT INTO symbols (symbol, name, exchange) VALUES (?, ?, 'NSE')
   ON CONFLICT (symbol) DO UPDATE SET name = excluded.name`,
);
export const writeSymbols = db.transaction((rows: Array<{ symbol: string; name: string }>) => {
  for (const r of rows) upsertSymbol.run(r.symbol, r.name);
});

export function latestQuote(symbol: string): Quote | undefined {
  const row = db.prepare(`
    SELECT symbol, price, volume, day_high AS dayHigh, day_low AS dayLow, day_open AS dayOpen,
           prev_close AS prevClose, week52_high AS week52High, week52_low AS week52Low,
           as_of AS asOf, fetched_at AS fetchedAt, source, is_synthetic AS isSynthetic
    FROM quotes WHERE symbol = ? ORDER BY as_of DESC LIMIT 1
  `).get(symbol) as any;
  if (!row) return undefined;
  return { ...row, isSynthetic: !!row.isSynthetic } as Quote;
}

export function quoteCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM quotes`).get() as { n: number }).n;
}
