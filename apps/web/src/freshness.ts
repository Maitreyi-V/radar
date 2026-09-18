import type { Freshness } from './api';

/**
 * Staleness contract thresholds (ms).
 *
 * MUST STAY IN SYNC with STALENESS in apps/server/src/config.ts. The two workspaces
 * duplicate this the same way they duplicate the `Freshness` type itself — a deliberate
 * trade: one small hand-copied constant beats a shared build target for two numbers.
 * Change one, change the other.
 */
export const STALENESS = {
  live: 60_000,        // <= 60s  -> LIVE
  delayed: 900_000,    // <= 15m  -> DELAYED
} as const;

/**
 * Re-derive a freshness label from the age of the quote it belongs to.
 *
 * The age on screen ticks every second, so without this the label and the number
 * contradict each other the moment a feed goes quiet: "LIVE · 4m ago" is half honest,
 * which is worse than either half alone.
 *
 * Three states are returned untouched, because age alone cannot produce them and
 * guessing would be a lie rather than a gap:
 *
 *   REPLAY / RECORDED — provenance, not age. A replayed tick IS fresh by the clock; that
 *     is exactly why it must never be re-derived into LIVE. Same reasoning as the
 *     source check at the top of freshnessOf() on the server.
 *   MARKET_CLOSED — a market-phase fact the client has no signal for.
 *
 * KNOWN LIMITATION, deliberately left: if the market closes while a tab is open, this
 * walks LIVE -> DELAYED -> STALE instead of showing MARKET_CLOSED, because there is no
 * live market-phase signal between digest fetches. STALE is honest in that situation —
 * the data really is old — and the next digest fetch corrects the label. Closing the gap
 * properly means broadcasting market phase over SSE, which is a bigger change than the
 * problem warrants.
 */
export function freshnessFromAge(ageMs: number, current: Freshness): Freshness {
  if (current === 'REPLAY' || current === 'RECORDED' || current === 'MARKET_CLOSED') return current;
  if (ageMs <= STALENESS.live) return 'LIVE';
  if (ageMs <= STALENESS.delayed) return 'DELAYED';
  return 'STALE';                          // we'd rather say "old" than imply it's current
}
