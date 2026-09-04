/**
 * CLI: capture today's intraday tape.
 *
 *   npm run tape            one pass
 *   npm run tape -- --52w   also refresh 52-week ranges
 *   npm run tape -- --loop  keep topping up until ~5 min after the close
 *
 * Loop mode exists because the tape is the one artifact that cannot be recreated:
 * each pass is idempotent, so repeated runs simply extend the session already stored.
 */
import { captureTape } from '../ingestion/tape.js';
import { quoteCount } from '../ingestion/store.js';
import { marketPhase, msUntilClose } from '../ingestion/marketCalendar.js';
import { sleep } from '../ingestion/rateLimiter.js';

const with52Week = process.argv.includes('--52w');
const loop = process.argv.includes('--loop');
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function once(label: string): Promise<void> {
  const r = await captureTape({ with52Week });
  log(`[${label}] ${r.symbols} symbols, +${r.inserted} new, ${r.duplicate} dup, total=${quoteCount()}` +
      (r.failed.length ? ` failed=${r.failed.join(',')}` : ''));
}

async function main(): Promise<void> {
  if (!loop) { await once('single'); return; }

  const INTERVAL_MS = 8 * 60 * 1000;
  for (let pass = 1; ; pass++) {
    await once(`pass ${pass}`);
    const phase = marketPhase();
    if (phase !== 'OPEN') {
      // One final pass after the bell so the closing minutes are captured, then stop.
      log(`market ${phase}; final pass then exit`);
      await sleep(30_000);
      await once('final');
      return;
    }
    const wait = Math.min(INTERVAL_MS, Math.max(30_000, msUntilClose() + 60_000));
    log(`next pass in ${(wait / 60000).toFixed(1)} min (close in ${(msUntilClose() / 60000).toFixed(0)} min)`);
    await sleep(wait);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
