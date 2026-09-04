/**
 * Live tick recorder — captures the session that Replay mode plays back all weekend.
 *
 * Provider chain (order matters):
 *   1. BSE   — public quote API, no auth, ~1.6 req/s measured with zero failures.
 *   2. Yahoo — throttles hard (burst ~5, refill ~1/min, escalating penalty), so it is
 *              the FALLBACK, not the primary. It remains the source for daily bars.
 *
 * Each provider carries its own circuit breaker and its own AIMD pacing, because their
 * limits differ by two orders of magnitude. A single global rate would either crawl at
 * Yahoo's pace or hammer Yahoo at BSE's.
 */
import { BseAdapter } from './adapters/bse.js';
import { YahooAdapter } from './adapters/yahoo.js';
import { UNIVERSE, UNIVERSE_SYMBOLS } from './universe.js';
import { writeQuote, writeSymbols, quoteCount } from './store.js';
import { marketPhase, msUntilClose, sessionDate } from './marketCalendar.js';
import { AdaptiveRate } from './adaptiveRate.js';
import { prioritise } from './priority.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { sleep } from './rateLimiter.js';
import { ProviderError, type ProviderAdapter } from './types.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

interface ProviderState {
  adapter: ProviderAdapter;
  breaker: CircuitBreaker;
  rate: AdaptiveRate;
  ok: number;
  throttled: number;
  failed: number;
}

async function main(): Promise<void> {
  writeSymbols(UNIVERSE.map((s) => ({ symbol: s.symbol, name: s.name })));

  const providers: ProviderState[] = [
    { adapter: new BseAdapter(),   breaker: new CircuitBreaker('bse', 4, 30_000),
      rate: new AdaptiveRate(400, 60_000, 800, 100), ok: 0, throttled: 0, failed: 0 },
    { adapter: new YahooAdapter(), breaker: new CircuitBreaker('yahoo', 3, 120_000),
      rate: new AdaptiveRate(10_000, 300_000, 60_000, 5_000), ok: 0, throttled: 0, failed: 0 },
  ];

  const symbols = prioritise(UNIVERSE_SYMBOLS);
  const stats = { inserted: 0, duplicate: 0, stale: 0, disputed: 0, unavailable: 0 };
  let idx = 0;
  let stopping = false;

  log(`recorder up. phase=${marketPhase()} session=${sessionDate()} quotes=${quoteCount()} symbols=${symbols.length}`);
  log(`closeIn=${(msUntilClose() / 60000).toFixed(0)}min providers=${providers.map((p) => p.adapter.name).join(' -> ')}`);

  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  setInterval(() => {
    const per = providers.map((p) =>
      `${p.adapter.name}[${p.breaker.state} ok=${p.ok} 429=${p.throttled} err=${p.failed} ${(p.rate.current / 1000).toFixed(1)}s]`,
    ).join(' ');
    log(`${JSON.stringify(stats)} total=${quoteCount()} phase=${marketPhase()} ${per}`);
  }, 60_000);

  while (!stopping) {
    const symbol = symbols[idx % symbols.length]!;
    idx++;
    let served = false;

    for (const p of providers) {
      if (!p.breaker.canRequest()) continue;
      try {
        const quote = await p.adapter.fetchQuote(symbol);
        p.breaker.onSuccess();
        p.rate.onSuccess();
        p.ok++;
        stats[writeQuote(quote)]++;
        served = true;
        await sleep(p.rate.current);
        break;
      } catch (err) {
        const status = err instanceof ProviderError ? err.status : undefined;
        if (status === 429) { p.throttled++; p.rate.onThrottle(); p.breaker.onFailure('429'); }
        else { p.failed++; p.rate.onError(); p.breaker.onFailure(String(status ?? 'err')); }
        // fall through to the next provider in the chain
      }
    }

    if (!served) {
      stats.unavailable++;
      // Every provider is down or breaker-open. Last-known-good quotes stay in the DB,
      // so the app degrades to DELAYED rather than going blank.
      await sleep(2_000);
    }
  }

  log(`stopped. ${JSON.stringify(stats)} total=${quoteCount()}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
