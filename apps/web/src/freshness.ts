import { useEffect, useState } from 'react';
import type { Freshness } from './api';

/**
 * Keeping the freshness label honest in the browser.
 *
 * The server computes a label at the moment it builds a response. That answer is correct
 * exactly once: leave the tab open and a price the server truthfully called LIVE keeps
 * claiming to be LIVE an hour later. The age next to it ticked up while the word beside
 * it stayed frozen — which is precisely the quiet lie the chip exists to prevent.
 *
 * So the browser re-derives the label as time passes.
 */

/** MUST match STALENESS in apps/server/src/config.ts. The server computes the first
 * label and the browser keeps it current; the two disagreeing is worse than either. */
export const STALENESS = { live: 60_000, delayed: 900_000 } as const;

/**
 * Labels the browser must NOT touch.
 *
 * REPLAY and RECORDED describe where the data CAME FROM, not how old it is — a replayed
 * tick is genuinely fresh, and ageing it into LIVE would present a recording as live
 * market data. MARKET_CLOSED depends on the NSE trading calendar and holiday list, which
 * live on the server. For all three, the server's answer is the only honest one.
 */
const SERVER_AUTHORITATIVE: ReadonlySet<Freshness> = new Set<Freshness>(['REPLAY', 'RECORDED', 'MARKET_CLOSED']);

export const isServerAuthoritative = (label: Freshness): boolean => SERVER_AUTHORITATIVE.has(label);

/**
 * The exchange clock lives on the server; the browser's clock may be minutes off, and a
 * user with a skewed clock would otherwise see every LIVE price labelled STALE. Anchor
 * to the server's own `generatedAt` so ages are measured on its clock, not the laptop's.
 */
let skewMs = 0;
export function noteServerTime(serverNow: number): void { skewMs = Date.now() - serverNow; }
export const serverNow = (): number => Date.now() - skewMs;

/** Re-derive an age-based label. Only ever moves LIVE -> DELAYED -> STALE; time passing
 * can never make data fresher, so this can only downgrade. */
export function ageFreshness(label: Freshness, ageMs: number): Freshness {
  if (isServerAuthoritative(label)) return label;
  if (ageMs <= STALENESS.live) return 'LIVE';
  if (ageMs <= STALENESS.delayed) return 'DELAYED';
  return 'STALE';
}

/** A ticking clock on the server's timeline. `active: false` skips the timer entirely,
 * so chips whose label can never change do not re-render once a second forever. */
export function useNow(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}
