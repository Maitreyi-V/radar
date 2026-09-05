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

  /**
   * Anchor to the session BEFORE the one we have recorded prices for — not "yesterday".
   *
   * The demo's current prices come from the recorded tape (Friday 4 Sep). Anchoring the
   * checkpoint to the previous *calendar* session breaks as soon as the wall clock moves
   * past that day: once it is Saturday, "the previous session" IS Friday, so the digest
   * compares Friday against Friday, every move is 0.00%, and the hero moment silently
   * empties out. Deriving the anchor from the DATA rather than from today's date keeps the
   * demo identical whether a judge opens it on Friday evening or Monday morning.
   */
  const recorded = db.prepare(
    `SELECT MAX(session_date) AS d FROM quotes WHERE source = 'bse-intraday'`,
  ).get() as { d: string | null };
  if (!recorded.d) throw new Error('no recorded session in quotes — run `npm run tape` first');

  const prev = db.prepare(
    `SELECT DISTINCT bar_date FROM daily_bars WHERE bar_date < ? ORDER BY bar_date DESC LIMIT 1`,
  ).get(recorded.d) as { bar_date: string } | undefined;
  if (!prev) throw new Error('no daily_bars before the recorded session — run `npm run bhavcopy` first');
  console.log(`recorded session: ${recorded.d} -> anchoring checkpoint to the close of ${prev.bar_date}`);

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
