import { db } from '../db/index.js';
import { freshnessOf } from '../digest/build.js';
import type { DataMode, Freshness } from '../digest/types.js';

export interface QuoteView {
  symbol: string; name: string; price: number; volume: number | null;
  dayOpen: number | null; prevClose: number | null; dayHigh: number | null; dayLow: number | null;
  week52High: number | null; week52Low: number | null;
  changePct: number | null; refPrice: number | null; refChangePct: number | null;
  asOf: number; fetchedAt: number; source: string;
  freshness: Freshness; ageMs: number;
  sparkline: number[];
}

/**
 * Latest quote per symbol in a watchlist, plus a short sparkline.
 *
 * Uses a window function to pick the newest row per symbol in ONE query instead of
 * N+1 lookups — the difference matters once a watchlist has 50 symbols.
 */
/**
 * Latest row per symbol, with sparse fields back-filled from the newest row that HAS them.
 *
 * Why the back-fill: different providers populate different fields. BSE's quote endpoint
 * gives a fast price but no volume and no 52-week range; the intraday-tape rows carry
 * both. Taking the single newest row would therefore blank out volume whenever a quote
 * tick happens to be newer than the last tape row.
 *
 * We take price/timestamp from the newest row (that is what "current" means) but carry
 * each sparse field forward from its own most recent non-null observation. Volume is
 * cumulative and the 52w range is a slow-moving level, so the last known value is the
 * correct value — not a guess.
 */
const LATEST_SQL = `
  WITH mine AS (
    SELECT q.* FROM quotes q
    WHERE q.symbol IN (SELECT symbol FROM watchlist_items WHERE watchlist_id = @wid)
  ),
  ranked AS (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.symbol ORDER BY m.as_of DESC, m.id DESC) AS rn
    FROM mine m
  ),
  latest_vol AS (
    SELECT symbol, volume, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC, id DESC) AS rn
    FROM mine WHERE volume IS NOT NULL
  ),
  latest_52 AS (
    SELECT symbol, week52_high, week52_low,
           ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC, id DESC) AS rn
    FROM mine WHERE week52_high IS NOT NULL OR week52_low IS NOT NULL
  ),
  latest_ohlc AS (
    SELECT symbol, day_open, prev_close, day_high, day_low,
           ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC, id DESC) AS rn
    FROM mine WHERE prev_close IS NOT NULL
  )
  SELECT r.symbol, r.price,
         COALESCE(r.volume, lv.volume)             AS volume,
         COALESCE(r.day_open, lo.day_open)         AS dayOpen,
         COALESCE(r.prev_close, lo.prev_close)     AS prevClose,
         COALESCE(r.day_high, lo.day_high)         AS dayHigh,
         COALESCE(r.day_low, lo.day_low)           AS dayLow,
         COALESCE(r.week52_high, l5.week52_high)   AS week52High,
         COALESCE(r.week52_low, l5.week52_low)     AS week52Low,
         r.as_of AS asOf, r.fetched_at AS fetchedAt, r.source,
         wi.ref_price AS refPrice,
         COALESCE(s.name, r.symbol) AS name
  FROM ranked r
  JOIN watchlist_items wi ON wi.watchlist_id = @wid AND wi.symbol = r.symbol
  LEFT JOIN symbols s ON s.symbol = r.symbol
  LEFT JOIN latest_vol  lv ON lv.symbol = r.symbol AND lv.rn = 1
  LEFT JOIN latest_52   l5 ON l5.symbol = r.symbol AND l5.rn = 1
  LEFT JOIN latest_ohlc lo ON lo.symbol = r.symbol AND lo.rn = 1
  WHERE r.rn = 1
  ORDER BY wi.added_at ASC
`;

/**
 * Sparkline over TODAY'S SESSION, evenly sampled — not the last N ticks.
 *
 * The row already shows a day-change percentage measured from the previous close. If the
 * sparkline covered only the last 40 minutes, a stock could show "+1.6%" beside a line
 * sloping down, and both would be correct while together being misleading. Sampling the
 * whole session makes the picture and the number describe the same window.
 */
const SPARK_SQL = `
  WITH day AS (
    SELECT price, ROW_NUMBER() OVER (ORDER BY as_of ASC) AS rn, COUNT(*) OVER () AS total
    FROM quotes
    WHERE symbol = ? AND session_date = (SELECT MAX(session_date) FROM quotes WHERE symbol = ?)
  )
  SELECT price FROM day
  WHERE total <= 48 OR rn % CAST(MAX(total / 48, 1) AS INTEGER) = 0
  ORDER BY rn ASC
`;

export function watchlistQuotes(
  watchlistId: string,
  now = Date.now(),
  dataMode: DataMode = 'CURRENT',
): QuoteView[] {
  const rows = db.prepare(LATEST_SQL).all({ wid: watchlistId }) as any[];
  const spark = db.prepare(SPARK_SQL);

  return rows.map((r) => {
    const base = r.prevClose;
    const points = (spark.all(r.symbol, r.symbol) as Array<{ price: number }>).map((p) => p.price);
    return {
      ...r,
      changePct: base && base > 0 ? round2(((r.price - base) / base) * 100) : null,
      refChangePct: r.refPrice && r.refPrice > 0 ? round2(((r.price - r.refPrice) / r.refPrice) * 100) : null,
      freshness: freshnessOf(r.asOf, now, r.source, dataMode),
      ageMs: Math.max(0, now - r.asOf),
      sparkline: points,
    } as QuoteView;
  });
}

/** Intraday series for the drill-down chart. */
export function symbolHistory(symbol: string, limit = 400): Array<{ asOf: number; price: number; volume: number | null }> {
  return db.prepare(
    `SELECT as_of AS asOf, price, volume FROM quotes WHERE symbol = ?
     ORDER BY as_of DESC LIMIT ?`,
  ).all(symbol, limit).reverse() as any;
}

export function searchSymbols(q: string, limit = 12): Array<{ symbol: string; name: string }> {
  const like = `%${q.trim().toUpperCase()}%`;
  return db.prepare(
    `SELECT symbol, name FROM symbols
     WHERE UPPER(symbol) LIKE ? OR UPPER(name) LIKE ?
     ORDER BY CASE WHEN UPPER(symbol) LIKE ? THEN 0 ELSE 1 END, mktcap DESC NULLS LAST
     LIMIT ?`,
  ).all(like, like, `${q.trim().toUpperCase()}%`, limit) as any;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
