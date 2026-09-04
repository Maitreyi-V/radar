/**
 * CLI: print the volatility table behind the thesis.
 *
 *   npm run explain
 *
 * Shows, for every symbol on the demo watchlist, its own 30-day sigma, its move, and the
 * resulting z-score — so the claim "significance is relative, not absolute" can be checked
 * against real data rather than taken on trust. This is the table reproduced in the README.
 */
import { db } from '../db/index.js';
import { volatility, type Bar } from '../significance/stats.js';
import { THRESHOLDS } from '../significance/detectors.js';

const rows = db.prepare(`
  SELECT wi.symbol, wi.ref_price AS ref FROM watchlist_items wi
  JOIN watchlists w ON w.id = wi.watchlist_id
  JOIN users u ON u.id = w.user_id
  WHERE u.email = ? ORDER BY wi.symbol
`).all(process.env.SEED_EMAIL ?? 'demo@radar.dev') as Array<{ symbol: string; ref: number | null }>;

if (rows.length === 0) {
  console.log('no demo watchlist found — run `npm run seed` first');
  process.exit(0);
}

const barsFor = db.prepare(
  `SELECT bar_date AS date, open, high, low, close, volume FROM daily_bars WHERE symbol = ? ORDER BY bar_date`,
);
const latest = db.prepare(
  `SELECT price, prev_close AS prevClose FROM quotes WHERE symbol = ? ORDER BY as_of DESC LIMIT 1`,
);

console.log(`\nSignificance is relative, not absolute — fires at |z| >= ${THRESHOLDS.volatilityZ}\n`);
console.log('symbol          own sigma     day move     z-score   verdict');
console.log('─'.repeat(64));

const out: Array<{ sym: string; sigma: number; move: number; z: number }> = [];
for (const r of rows) {
  const bars = barsFor.all(r.symbol) as Bar[];
  const q = latest.get(r.symbol) as { price: number; prevClose: number | null } | undefined;
  const sigma = volatility(bars, 30);
  if (!q?.prevClose || sigma === null) {
    console.log(`${short(r.symbol).padEnd(14)} insufficient history — detector stays silent`);
    continue;
  }
  const move = (q.price - q.prevClose) / q.prevClose;
  out.push({ sym: short(r.symbol), sigma, move, z: move / sigma });
}

// Sorted by raw % move, so the inversions against z-score are easy to spot.
out.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
for (const x of out) {
  const fires = Math.abs(x.z) >= THRESHOLDS.volatilityZ;
  console.log(
    x.sym.padEnd(14) +
    `${(x.sigma * 100).toFixed(2)}%/day`.padStart(12) +
    `${(x.move * 100>= 0 ? '+' : '')}${(x.move * 100).toFixed(2)}%`.padStart(13) +
    `${x.z.toFixed(2)}σ`.padStart(11) +
    (fires ? '   SURFACED' : '   silent'),
  );
}
console.log(
  '\nRead down the "day move" column: it is sorted by raw percentage, yet the verdict\n' +
  'column does not follow it. That mismatch is the entire product argument.\n',
);

function short(s: string): string { return s.replace(/\.(NS|BO)$/, ''); }
