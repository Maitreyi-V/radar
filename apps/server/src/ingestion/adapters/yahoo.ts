import type { ProviderAdapter, Quote, DailyBar } from '../types.js';
import { ProviderError } from '../types.js';
import { TokenBucket, backoffMs, sleep } from '../rateLimiter.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/**
 * Yahoo Finance v8 chart adapter.
 *
 * NOTE (verified 2026-09-04): v7/finance/quote and v10/quoteSummary now return 401.
 * v8/finance/chart is the only endpoint still reachable unauthenticated, so the whole
 * adapter is built on it. Two field traps confirmed empirically:
 *   - meta.previousClose is null    -> use meta.chartPreviousClose
 *   - meta.regularMarketOpen is null -> use indicators.quote[0].open[0]
 */
export class YahooAdapter implements ProviderAdapter {
  readonly name = 'yahoo';

  /** Shared across every call: ~3 req/s sustained, small burst allowance. */
  private readonly bucket = new TokenBucket(4, 3);

  constructor(private readonly host = 'query1.finance.yahoo.com') {}

  private async getOnce(url: string): Promise<any> {
    await this.bucket.take();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
      if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, this.name, res.status);
      return await res.json();
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err), this.name);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retry only on 429/5xx — transient. A 404 is a bad symbol and must not be retried. */
  private async get(url: string, attempts = 3): Promise<any> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.getOnce(url);
      } catch (err: any) {
        last = err;
        const status = err?.status as number | undefined;
        const retryable = status === 429 || status === undefined || (status >= 500 && status < 600);
        if (!retryable || i === attempts - 1) break;
        await sleep(backoffMs(i));
      }
    }
    throw last;
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    const url = `https://${this.host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const json = await this.get(url);
    const result = json?.chart?.result?.[0];
    if (!result?.meta) throw new ProviderError(`no result for ${symbol}`, this.name);

    const m = result.meta;
    const price = num(m.regularMarketPrice);
    if (price === null) throw new ProviderError(`no price for ${symbol}`, this.name);

    const bar = result.indicators?.quote?.[0];
    const dayOpen = num(bar?.open?.[0]);

    return {
      symbol,
      price,
      volume: int(m.regularMarketVolume),
      dayHigh: num(m.regularMarketDayHigh),
      dayLow: num(m.regularMarketDayLow),
      dayOpen,
      prevClose: num(m.chartPreviousClose) ?? num(m.previousClose),
      week52High: num(m.fiftyTwoWeekHigh),
      week52Low: num(m.fiftyTwoWeekLow),
      // regularMarketTime is epoch SECONDS -> ms. This is the exchange's clock, not ours.
      asOf: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(),
      fetchedAt: Date.now(),
      source: this.name,
      isSynthetic: false,
    };
  }

  /** Daily bars -> the statistical base for sigma, 20d avg volume, 52w range. */
  async fetchDailyBars(symbol: string, days = 120): Promise<DailyBar[]> {
    const range = days <= 30 ? '1mo' : days <= 90 ? '3mo' : days <= 180 ? '6mo' : '1y';
    const url = `https://${this.host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
    const json = await this.get(url);
    const r = json?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const q = r?.indicators?.quote?.[0] ?? {};
    const gmt = (r?.meta?.gmtoffset ?? 19800) * 1000;

    const out: DailyBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = num(q.close?.[i]);
      if (close === null) continue;                       // Yahoo emits null bars on holidays
      const d = new Date(ts[i]! * 1000 + gmt);
      out.push({
        symbol,
        date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
        open: num(q.open?.[i]), high: num(q.high?.[i]), low: num(q.low?.[i]),
        close, volume: int(q.volume?.[i]),
      });
    }
    return out;
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
