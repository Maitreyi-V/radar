/**
 * Seed a demo account that behaves like a real returning user.
 *
 * Anchoring matters more than it looks. A checkpoint taken "now" has nothing to diff
 * against, and one taken at today's 09:15 open only spans a few hours — over which
 * almost nothing crosses 1.5 sigma. A real user who checks their watchlist daily last
 * looked *after yesterday's close*, so that is where the checkpoint belongs.
 *
 * Everything here comes from recorded data:
 *   - checkpoint prices  = yesterday's official closes (NSE bhavcopy)
 *   - ref_price          = the close ~20 sessions ago, i.e. "you added this a month ago"
 * No fabricated events, no fixtures. The digest is the real engine over the real tape.
 */
import { db, tx } from '../db/index.js';
import { createUser, findUserByEmail, newId } from '../api/auth.js';
import { createWatchlist } from '../api/watchlists.js';

const EMAIL = process.env.SEED_EMAIL ?? 'demo@radar.dev';
const PASSWORD = process.env.SEED_PASSWORD ?? 'radar123';
/** How many sessions ago the demo user "added" these stocks. */
const ADDED_SESSIONS_AGO = 20;

const SYMBOLS = [
  'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS', 'ITC.NS',
  'BHARTIARTL.NS', 'SBIN.NS', 'TATAMOTORS.NS', 'SUZLON.NS', 'IDEA.NS',
  'YESBANK.NS', 'PAYTM.NS', 'IRCTC.NS', 'BEL.NS', 'HAL.NS',
];

/** Epoch ms of 15:30 IST on an ISO date. */
function closeInstant(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!, 15, 30) - 5.5 * 3600_000;
}

function main(): void {
  let user = findUserByEmail(EMAIL);
  if (!user) {
    const c = createUser(EMAIL, PASSWORD);
    user = { id: c.id, email: c.email, pw_hash: '' };
    console.log(`created ${EMAIL} / ${PASSWORD}`);
  } else {
    console.log(`reusing ${EMAIL}`);
    db.prepare(`DELETE FROM watchlists WHERE user_id = ?`).run(user.id);
  }
  const userId = user.id;
  const wl = createWatchlist(userId, 'Demo Watchlist');

  // The most recent completed session — the one before today.
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const prev = db.prepare(
    `SELECT DISTINCT bar_date FROM daily_bars WHERE bar_date < ? ORDER BY bar_date DESC LIMIT 1`,
  ).get(today) as { bar_date: string } | undefined;
  if (!prev) throw new Error('no daily_bars — run `npm run bhavcopy` first');

  const takenAt = closeInstant(prev.bar_date);
  const closeOn = db.prepare(`SELECT close, volume FROM daily_bars WHERE symbol = ? AND bar_date = ?`);
  const nthBack = db.prepare(
    `SELECT close, bar_date FROM daily_bars WHERE symbol = ? AND bar_date < ?
     ORDER BY bar_date DESC LIMIT 1 OFFSET ?`,
  );

  tx(() => {
    const addItem = db.prepare(
      `INSERT INTO watchlist_items (watchlist_id, symbol, added_at, ref_price)
       VALUES (?, ?, ?, ?) ON CONFLICT (watchlist_id, symbol) DO NOTHING`,
    );
    const snapshot: Record<string, unknown> = {};
    let added = 0;

    for (const s of SYMBOLS) {
      const last = closeOn.get(s, prev.bar_date) as { close: number; volume: number | null } | undefined;
      if (!last) { console.log(`  ! no ${prev.bar_date} bar for ${s}, skipped`); continue; }
      const ref = nthBack.get(s, prev.bar_date, ADDED_SESSIONS_AGO - 1) as { close: number; bar_date: string } | undefined;

      addItem.run(wl.id, s, takenAt, ref?.close ?? last.close);
      snapshot[s] = { price: last.close, dayHigh: null, dayLow: null, volume: last.volume, asOf: takenAt };
      added++;
    }

    db.prepare(
      `INSERT INTO checkpoints (id, user_id, watchlist_id, taken_at, snapshot) VALUES (?, ?, ?, ?, ?)`,
    ).run(newId(), userId, wl.id, takenAt, JSON.stringify(snapshot));

    console.log(`seeded ${added} symbols`);
    console.log(`checkpoint = close of ${prev.bar_date} (${new Date(takenAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST)`);
    console.log(`ref_price  = close ~${ADDED_SESSIONS_AGO} sessions earlier`);
  });

  console.log(`\nsign in:  ${EMAIL} / ${PASSWORD}`);
}

main();
