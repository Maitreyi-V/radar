/**
 * Daily-bar backfill. Historical data, so it is safe to run any time — including the
 * weekend, when nothing competes for the request budget. Deliberately NOT part of the
 * live recorder.
 */
import { YahooAdapter } from './adapters/yahoo.js';
import { UNIVERSE_SYMBOLS } from './universe.js';
import { writeDailyBars } from './store.js';
import { db } from '../db/index.js';
import { AdaptiveRate } from './adaptiveRate.js';
import { sleep } from './rateLimiter.js';
import { ProviderError } from './types.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function missingSymbols(minBars = 200): string[] {
  const have = db.prepare(
    `SELECT symbol, COUNT(*) n FROM daily_bars GROUP BY symbol HAVING n >= ?`,
  ).all(minBars) as Array<{ symbol: string; n: number }>;
  const done = new Set(have.map((r) => r.symbol));
  return UNIVERSE_SYMBOLS.filter((s) => !done.has(s));
}

async function main(): Promise<void> {
  const yahoo = new YahooAdapter();
  const rate = new AdaptiveRate(4_000, 300_000, 15_000);
  let queue = missingSymbols();
  log(`backfill: ${queue.length} symbols missing daily history`);

  let ok = 0, fail = 0;
  while (queue.length > 0) {
    const symbol = queue[0]!;
    try {
      const bars = await yahoo.fetchDailyBars(symbol, 365);
      writeDailyBars(bars);
      rate.onSuccess();
      queue.shift();
      ok++;
      log(`  ✓ ${symbol}: ${bars.length} bars  (${queue.length} left, ${(rate.current / 1000).toFixed(1)}s)`);
    } catch (err) {
      const status = err instanceof ProviderError ? err.status : undefined;
      if (status === 429) { rate.onThrottle(); log(`  ! 429 ${symbol} -> ${(rate.current / 1000).toFixed(0)}s`); }
      else { rate.onError(); fail++; log(`  ! ${symbol}: ${String(err)}`);
             if (fail % 5 === 0) { queue.shift(); queue.push(symbol); } }  // rotate persistent failures
    }
    await sleep(rate.current);
  }
  log(`backfill complete: ${ok} symbols`);
}

main().catch((e) => { console.error(e); process.exit(1); });
