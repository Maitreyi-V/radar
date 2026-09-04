/**
 * CLI: load daily history from NSE bhavcopy.
 *   npm run bhavcopy            last 45 trading days
 *   npm run bhavcopy -- 90      last 90
 */
import { importDay, recentTradingDays } from '../ingestion/bhavcopy.js';
import { AdaptiveRate } from '../ingestion/adaptiveRate.js';
import { sleep } from '../ingestion/rateLimiter.js';
import { db } from '../db/index.js';

const days = Number(process.argv[2] ?? 45);
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function main(): Promise<void> {
  // Skip today: the file only lands after the session settles.
  const dates = recentTradingDays(days + 1).slice(1);
  const rate = new AdaptiveRate(600, 60_000, 1_000, 150);
  let ok = 0, missing = 0, failed = 0, rows = 0;

  log(`importing ${dates.length} trading days of NSE bhavcopy…`);
  for (const d of dates) {
    const r = await importDay(d);
    if (r.status === 'ok') { ok++; rows += r.rows; rate.onSuccess(); log(`  ✓ ${d}: ${r.rows} rows`); }
    else if (r.status === 'missing') { missing++; rate.onSuccess(); log(`  · ${d}: no file (holiday)`); }
    else { failed++; rate.onError(); log(`  ! ${d}: ${r.detail}`); }
    await sleep(rate.current);
  }

  const cov = db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT symbol FROM daily_bars GROUP BY symbol HAVING COUNT(*) >= 20)`,
  ).get() as { n: number };

  log(`done: ${ok} days ok, ${missing} missing, ${failed} failed, ${rows} bars written`);
  log(`symbols with >=20 daily bars: ${cov.n}/60`);
}

main().catch((e) => { console.error(e); process.exit(1); });
