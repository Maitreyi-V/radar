import type { ProviderAdapter, Quote } from '../types.js';
import { ProviderError } from '../types.js';
import { httpGet } from '../http.js';
import { db } from '../../db/index.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bseindia.com/' };

/**
 * BSE India adapter.
 *
 * Why a second provider at all: Yahoo throttles hard (burst ~5, refill ~1/min) and its
 * penalty escalates, so it cannot sustain a live poll on its own. BSE's public quote
 * API has no auth and tolerated ~1.6 req/s in testing with zero failures.
 *
 * It also makes the CONFLICT POLICY real rather than theoretical: BSE and NSE are
 * different exchanges, so the same company genuinely carries two slightly different
 * prices at the same instant. That is a true disagreement to resolve, not a simulated one.
 *
 * Provides: LTP, open, high, low, previous close, exchange timestamp.
 * Does NOT provide: volume, 52-week range — those come from `daily_bars`. We leave
 * them null rather than inventing them.
 */
export class BseAdapter implements ProviderAdapter {
  readonly name = 'bse';

  /** symbol -> BSE scripcode, resolved from the `symbols` table. */
  private codeOf(symbol: string): string | null {
    const row = db.prepare(`SELECT bse_code FROM symbols WHERE symbol = ?`).get(symbol) as
      | { bse_code: string | null } | undefined;
    return row?.bse_code ?? null;
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    const code = this.codeOf(symbol);
    if (!code) throw new ProviderError(`no BSE scripcode for ${symbol}`, this.name);

    const url = `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${code}&seriesid=`;
    let res;
    try {
      res = await httpGet(url, { headers: HEADERS, timeoutMs: 10_000, insecureParser: true });
    } catch (err: any) {
      throw new ProviderError(String(err?.message ?? err), this.name);
    }
    if (res.status !== 200) throw new ProviderError(`HTTP ${res.status}`, this.name, res.status);

    let json: any;
    try { json = JSON.parse(res.body); }
    catch { throw new ProviderError('invalid JSON', this.name); }

    const h = json?.Header;
    const price = num(h?.LTP) ?? num(json?.CurrRate?.LTP);
    if (price === null) throw new ProviderError(`no price for ${symbol}`, this.name);

    return {
      symbol,
      price,
      volume: null,           // not in this endpoint — never fabricated
      dayHigh: num(h?.High),
      dayLow: num(h?.Low),
      dayOpen: num(h?.Open),
      prevClose: num(h?.PrevClose),
      week52High: null,
      week52Low: null,
      asOf: parseAson(h?.Ason) ?? Date.now(),
      fetchedAt: Date.now(),
      source: this.name,
      isSynthetic: false,
    };
  }
}

/**
 * Today's full intraday minute series, in ONE request.
 *
 * This is the single most valuable endpoint we found: it returns every minute from
 * 09:15 to now with price AND traded volume, so a recorder that starts late can still
 * recover the entire session. Combined with UNIQUE(symbol, as_of, source), re-running
 * it is idempotent — only genuinely new minutes insert — so we can call it repeatedly
 * through the day and again at the close to capture the complete tape.
 */
export interface IntradayPoint { asOf: number; price: number; volume: number | null }

export async function fetchIntradaySeries(
  scripCode: string,
): Promise<{ points: IntradayPoint[]; prevClose: number | null; dayHigh: number | null; dayLow: number | null }> {
  const url = `https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w?scripcode=${scripCode}&flag=0&fromdate=&todate=&seriesid=`;
  const res = await httpGet(url, { headers: HEADERS, timeoutMs: 20_000, insecureParser: true });
  if (res.status !== 200) throw new ProviderError(`HTTP ${res.status}`, 'bse', res.status);

  const outer = JSON.parse(res.body);
  // `Data` is a JSON STRING nested inside the JSON body — double-encoded by the API.
  const raw = typeof outer?.Data === 'string' ? JSON.parse(outer.Data) : (outer?.Data ?? []);

  const points: IntradayPoint[] = [];
  for (const p of raw as Array<{ dttm: string; vale1: string; vole: string }>) {
    const asOf = parseGraphDttm(p.dttm);
    const price = Number(p.vale1);
    if (asOf === null || !Number.isFinite(price) || price <= 0) continue;
    const vol = Number(p.vole);
    points.push({ asOf, price, volume: Number.isFinite(vol) ? vol : null });
  }
  points.sort((a, b) => a.asOf - b.asOf);

  return {
    points,
    prevClose: toNum(outer?.PrevClose),
    dayHigh: toNum(outer?.HighVal),
    dayLow: toNum(outer?.LowVal),
  };
}

/** 52-week range — absent from the quote endpoint, present here. */
export async function fetch52Week(scripCode: string): Promise<{ high: number | null; low: number | null }> {
  const url = `https://api.bseindia.com/BseIndiaAPI/api/HighLow/w?Type=EQ&flag=C&scripcode=${scripCode}`;
  const res = await httpGet(url, { headers: HEADERS, timeoutMs: 15_000, insecureParser: true });
  if (res.status !== 200) throw new ProviderError(`HTTP ${res.status}`, 'bse', res.status);
  const j = JSON.parse(res.body);
  return { high: toNum(j?.Fifty2WkHigh_adj), low: toNum(j?.Fifty2WkLow_adj) };
}

/** "Fri Sep 04 2026 09:15:59" (IST, no zone marker) -> epoch ms. */
export function parseGraphDttm(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mon, d, y, hh, mm, ss] = m;
  const month = MONTHS[mon!.toLowerCase()];
  if (month === undefined) return null;
  const utc = Date.UTC(Number(y), month, Number(d), Number(hh), Number(mm), Number(ss));
  return utc - 5.5 * 60 * 60 * 1000;
}

const toNum = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * BSE reports its timestamp as "04 Sep 26 | 12:05" in IST, with no zone marker.
 * Parsed explicitly rather than handed to `new Date()`, whose behaviour on this
 * format is implementation-defined and would silently apply the server's local zone.
 */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function parseAson(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s*\|\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, d, mon, y, hh, mm] = m;
  const month = MONTHS[mon!.toLowerCase()];
  if (month === undefined) return null;
  const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  // Build as UTC then subtract the IST offset, so the result is a true epoch instant
  // regardless of what timezone this server happens to run in.
  const utc = Date.UTC(year, month, Number(d), Number(hh), Number(mm), 0);
  return utc - 5.5 * 60 * 60 * 1000;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').trim());
    return Number.isFinite(n) && n !== 0 ? n : null;
  }
  return null;
};
