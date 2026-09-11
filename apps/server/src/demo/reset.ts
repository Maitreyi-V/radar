import { db, tx } from '../db/index.js';
import { newId } from '../api/auth.js';

/**
 * Restore the demo account to its "you were last here before the recorded session" state.
 *
 * Why this exists: the demo account is SHARED. The tab-hide checkpoint is correct product
 * behaviour for a real user — leaving means you are caught up — but on an account many
 * people open in turn, the first visitor who reads for thirty seconds and switches tabs
 * moves the anchor, and everyone after them lands on "Quiet since you left". The feature
 * working as designed quietly destroys the thing it is meant to demonstrate.
 *
 * Rather than special-case the behaviour away, the demo can be put back with one click.
 * The reset is derived entirely from recorded data — no fixtures — so it produces exactly
 * the same digest every time, whichever day it is run.
 */
export const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@radar.dev';
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

export interface ResetResult { watchlistId: string; symbols: number; anchoredTo: string }

export interface RecordedDemoContext { sessionDate: string; now: number }

/**
 * A stable clock for the recorded demo.
 *
 * Scoring a 4 Sep recording against today's wall clock makes the exact same demo fade
 * away a few trading sessions later. The recording is a closed world, so its honest
 * evaluation time is the final timestamp in that recording, not Date.now().
 */
export function recordedDemoContext(): RecordedDemoContext {
  const row = db.prepare(`
    WITH recorded AS (
      SELECT MAX(session_date) AS sessionDate
      FROM quotes
      WHERE source = 'bse-intraday' AND session_date IS NOT NULL
    )
    SELECT recorded.sessionDate, MAX(quotes.as_of) AS now
    FROM recorded
    JOIN quotes ON quotes.session_date = recorded.sessionDate
    WHERE quotes.source <> 'replay'
  `).get() as { sessionDate: string | null; now: number | null };
  if (!row.sessionDate || row.now === null) throw new Error('no recorded session available');
  return { sessionDate: row.sessionDate, now: row.now };
}

export function resetDemo(userId: string): ResetResult {
  // Anchor to the session BEFORE the most recent one we hold prices for, so the demo is
  // identical whichever day it is opened (see DECISIONS D41).
  const recorded = recordedDemoContext();

  const prev = db.prepare(
    `SELECT DISTINCT bar_date FROM daily_bars WHERE bar_date < ? ORDER BY bar_date DESC LIMIT 1`,
  ).get(recorded.sessionDate) as { bar_date: string } | undefined;
  if (!prev) throw new Error('no daily history before the recorded session');

  const takenAt = closeInstant(prev.bar_date);

  return tx(() => {
    db.prepare(`DELETE FROM watchlists WHERE user_id = ?`).run(userId);

    const wlId = newId();
    db.prepare(
      `INSERT INTO watchlists (id, user_id, name, version, created_at) VALUES (?, ?, ?, 1, ?)`,
    ).run(wlId, userId, 'Demo Watchlist', takenAt);

    const closeOn = db.prepare(`SELECT close, volume FROM daily_bars WHERE symbol = ? AND bar_date = ?`);
    const nthBack = db.prepare(
      `SELECT close FROM daily_bars WHERE symbol = ? AND bar_date < ? ORDER BY bar_date DESC LIMIT 1 OFFSET ?`,
    );
    const addItem = db.prepare(
      `INSERT INTO watchlist_items (watchlist_id, symbol, added_at, ref_price)
       VALUES (?, ?, ?, ?) ON CONFLICT (watchlist_id, symbol) DO NOTHING`,
    );

    const snapshot: Record<string, unknown> = {};
    let added = 0;
    for (const s of SYMBOLS) {
      const last = closeOn.get(s, prev.bar_date) as { close: number; volume: number | null } | undefined;
      if (!last) continue;
      const ref = nthBack.get(s, prev.bar_date, ADDED_SESSIONS_AGO - 1) as { close: number } | undefined;
      addItem.run(wlId, s, takenAt, ref?.close ?? last.close);
      snapshot[s] = { price: last.close, dayHigh: null, dayLow: null, volume: last.volume, asOf: takenAt };
      added++;
    }

    db.prepare(
      `INSERT INTO checkpoints (id, user_id, watchlist_id, taken_at, snapshot) VALUES (?, ?, ?, ?, ?)`,
    ).run(newId(), userId, wlId, takenAt, JSON.stringify(snapshot));

    // Events recorded against the old watchlist would damp novelty for a fresh demo.
    db.prepare(`DELETE FROM events`).run();

    return { watchlistId: wlId, symbols: added, anchoredTo: prev.bar_date };
  });
}
