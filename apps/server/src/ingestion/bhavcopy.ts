/**
 * NSE bhavcopy importer — the right way to load daily history.
 *
 * The exchange publishes ONE file per trading day containing OHLC and volume for every
 * listed symbol (~2,600 EQ rows). So N days of history for the WHOLE universe costs N
 * requests, not N x symbols. Loading 40 sessions for 60 symbols is 40 requests here
 * versus 60 per-symbol calls to Yahoo — which is why this survives rate limits that
 * per-symbol fetching does not.
 *
 * It is also the canonical source: this is the exchange's own end-of-day record, not a
 * third party's reconstruction of it. Symbols are plain NSE tickers, so no scripcode
 * mapping is involved.
 */
import { httpGet } from './http.js';
import { db } from '../db/index.js';
import { UNIVERSE_SYMBOLS } from './universe.js';
import { isTradingDay } from './marketCalendar.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  Referer: 'https://www.nseindia.com/',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Corporate-action aliases: our internal symbol -> the ticker NSE files it under today.
 *
 * Kept as an explicit, dated map rather than renaming our symbols, because our recorded
 * Friday tape is keyed on the internal names and renaming would orphan it.
 *   - Tata Motors demerged; the entity we track lists as TMCV (verified by price:
 *     TMCV closed 460.35 against our live 459.00, while TMPV was at 312.00).
 *   - Zomato renamed itself Eternal Ltd.
 */
const ALIASES: Record<string, string> = {
  'TATAMOTORS.NS': 'TMCV',
  'ZOMATO.NS': 'ETERNAL',
};

/** Universe tickers without the .NS suffix — bhavcopy uses bare NSE symbols. */
const WANTED = new Map<string, string>(
  UNIVERSE_SYMBOLS.map((s) => [(ALIASES[s] ?? s.replace(/\.(NS|BO)$/, '')).toUpperCase(), s]),
);

export interface BhavRow { symbol: string; date: string; open: number | null; high: number | null; low: number | null; close: number; volume: number | null }

const upsert = db.prepare(`
  INSERT INTO daily_bars (symbol, bar_date, open, high, low, close, volume)
  VALUES (@symbol, @date, @open, @high, @low, @close, @volume)
  ON CONFLICT (symbol, bar_date) DO UPDATE SET
    open=excluded.open, high=excluded.high, low=excluded.low,
    close=excluded.close, volume=excluded.volume
`);
const writeRows = db.transaction((rows: BhavRow[]) => { for (const r of rows) upsert.run(r); });

/** 'YYYY-MM-DD' -> the DDMMYYYY the archive URL expects. */
function urlFor(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`;
}

/** '03-Sep-2026' -> '2026-09-03' */
function isoFromBhavDate(s: string): string | null {
  const m = s.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1]}`;
}

export type DayResult = { date: string; status: 'ok'; rows: number } | { date: string; status: 'missing' | 'error'; detail?: string };

/** Fetch and store one trading day. `missing` means a holiday we did not know about. */
export async function importDay(iso: string): Promise<DayResult> {
  let res;
  try {
    res = await httpGet(urlFor(iso), { headers: HEADERS, timeoutMs: 25_000, insecureParser: true });
  } catch (err: any) {
    return { date: iso, status: 'error', detail: String(err?.message ?? err) };
  }
  if (res.status === 404) return { date: iso, status: 'missing' };
  if (res.status !== 200) return { date: iso, status: 'error', detail: `HTTP ${res.status}` };
  // The archive serves the site's HTML shell instead of a 404 for some absent files.
  if (!res.body.startsWith('SYMBOL')) return { date: iso, status: 'missing' };

  const lines = res.body.split('\n');
  const rows: BhavRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    // Fields carry leading spaces (", EQ, ") so every one is trimmed.
    const f = line.split(',').map((x) => x.trim());
    const [symbol, series, date1, , open, high, low, , close, , qty] = f;
    if (!symbol || series !== 'EQ') continue;          // ignore non-equity series
    const full = WANTED.get(symbol.toUpperCase());
    if (!full) continue;                                // only symbols we track
    const barDate = isoFromBhavDate(date1 ?? '');
    const c = num(close);
    if (!barDate || c === null) continue;
    rows.push({ symbol: full, date: barDate, open: num(open), high: num(high), low: num(low), close: c, volume: int(qty) });
  }

  writeRows(rows);
  return { date: iso, status: 'ok', rows: rows.length };
}

/** The last `count` trading days at or before `from`, newest first. */
export function recentTradingDays(count: number, from = Date.now()): string[] {
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i < count * 3 && out.length < count; i++) {
    if (isTradingDay(cursor)) {
      const d = new Date(cursor + 5.5 * 3600_000);
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
    }
    cursor -= 86_400_000;
  }
  return out;
}

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
