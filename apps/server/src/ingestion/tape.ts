/**
 * Intraday tape capture — the unrepeatable job.
 *
 * Pulls today's ENTIRE minute-by-minute series for every symbol from BSE, so a recorder
 * that started at 12:10 still captures the session from 09:15. Safe to run repeatedly:
 * UNIQUE(symbol, as_of, source) means only genuinely new minutes insert, so each run is
 * an incremental top-up rather than a duplicate import.
 *
 * Run it periodically through the day and once more just after 15:30 for the full tape.
 */
import { db } from '../db/index.js';
import { fetchIntradaySeries, fetch52Week } from './adapters/bse.js';
import { writeQuote } from './store.js';
import { AdaptiveRate } from './adaptiveRate.js';
import { sleep } from './rateLimiter.js';
import type { Quote } from './types.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

export interface TapeResult { symbols: number; inserted: number; duplicate: number; failed: string[] }

export async function captureTape(opts: { with52Week?: boolean } = {}): Promise<TapeResult> {
  const rows = db.prepare(
    `SELECT symbol, bse_code AS code FROM symbols WHERE bse_code IS NOT NULL ORDER BY symbol`,
  ).all() as Array<{ symbol: string; code: string }>;

  const rate = new AdaptiveRate(400, 30_000, 700, 100);
  const result: TapeResult = { symbols: 0, inserted: 0, duplicate: 0, failed: [] };

  for (const { symbol, code } of rows) {
    try {
      let hi: number | null = null, lo: number | null = null;
      if (opts.with52Week) {
        try { const w = await fetch52Week(code); hi = w.high; lo = w.low; }
        catch { /* 52w is optional context; never fail the tape over it */ }
        await sleep(rate.current);
      }

      const { points, prevClose, dayHigh, dayLow } = await fetchIntradaySeries(code);
      rate.onSuccess();

      // Volume in the series is PER-MINUTE traded quantity; the detectors want the
      // cumulative day volume, so accumulate as we walk forward through the session.
      let cum = 0;
      const dayOpen = points[0]?.price ?? null;
      let ins = 0, dup = 0;

      for (const p of points) {
        cum += p.volume ?? 0;
        const q: Quote = {
          symbol, price: p.price, volume: cum || null,
          dayHigh, dayLow, dayOpen, prevClose,
          week52High: hi, week52Low: lo,
          asOf: p.asOf, fetchedAt: Date.now(),
          source: 'bse-intraday', isSynthetic: false,
        };
        const r = writeQuote(q);
        if (r === 'inserted') ins++; else if (r === 'duplicate') dup++;
      }

      result.symbols++; result.inserted += ins; result.duplicate += dup;
      log(`  ${symbol}: ${points.length} pts (+${ins} new, ${dup} dup)`);
    } catch (err: any) {
      rate.onError();
      result.failed.push(symbol);
      log(`  ! ${symbol}: ${err?.message ?? err}`);
    }
    await sleep(rate.current);
  }
  return result;
}
