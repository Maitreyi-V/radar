import { BseAdapter } from './adapters/bse.js';
import { writeQuote, latestQuote } from './store.js';
import { db } from '../db/index.js';

/**
 * Fetch a quote for a symbol we do not poll on a schedule.
 *
 * The scheduler covers the curated universe, but a user can add any of ~5,000 listed
 * equities. Without this, a freshly added stock would sit in the watchlist showing
 * "no price data" until someone widened the universe by hand — which reads as broken.
 *
 * Deliberately best-effort and non-blocking for the caller's success path: adding a
 * symbol must succeed even if the provider is down. The watchlist row is the user's
 * intent; the quote is a detail we can fill in later.
 */
const bse = new BseAdapter();

/** Symbols already being fetched, so a double-tap does not fire two requests. */
const inFlight = new Set<string>();

export async function ensureQuote(symbol: string): Promise<boolean> {
  if (latestQuote(symbol)) return true;          // already have something
  if (inFlight.has(symbol)) return false;

  const known = db.prepare(`SELECT bse_code FROM symbols WHERE symbol = ?`).get(symbol) as
    | { bse_code: string | null } | undefined;
  if (!known?.bse_code) return false;            // we cannot price it; digest surfaces it as unavailable

  inFlight.add(symbol);
  try {
    const q = await bse.fetchQuote(symbol);
    writeQuote(q);
    return true;
  } catch {
    return false;                                // stays 'unavailable' — surfaced, never faked
  } finally {
    inFlight.delete(symbol);
  }
}
