import type { Freshness } from '../api';
import { ago } from '../format';
import { ageFreshness, isServerAuthoritative, useNow } from '../freshness';

/**
 * The honesty-first UI element.
 *
 * Every price on screen carries its own age. Most watchlists render a stale number with
 * no indication it is stale, which is a quiet lie. Showing the age — and saying
 * MARKET CLOSED plainly when nothing is trading — is a deliberate product stance.
 *
 * The chip owns its own clock. Given `asOf` it re-derives the label as time passes, so a
 * price does not keep claiming to be LIVE while the age beside it ticks past a minute.
 */
const STYLES: Record<Freshness, { label: string; cls: string; dot: string }> = {
  LIVE:          { label: 'LIVE',          cls: 'bg-up/10 text-up',                 dot: 'bg-up' },
  DELAYED:       { label: 'DELAYED',       cls: 'bg-amber-500/10 text-amber-400',   dot: 'bg-amber-400' },
  STALE:         { label: 'STALE',         cls: 'bg-down/10 text-down',             dot: 'bg-down' },
  MARKET_CLOSED: { label: 'MARKET CLOSED', cls: 'bg-slate-500/10 text-slate-400',   dot: 'bg-slate-500' },
  RECORDED:      { label: 'RECORDED',      cls: 'bg-violet-500/10 text-violet-300', dot: 'bg-violet-400' },
  // Replayed ticks are genuinely fresh, so an age check alone would call them LIVE.
  // They are labelled distinctly because presenting a recording as live market data
  // is precisely the kind of quiet lie this product refuses to tell.
  REPLAY:        { label: 'REPLAY',        cls: 'bg-accent/10 text-accent',         dot: 'bg-accent' },
};

export function FreshnessChip({ freshness, asOf, showAge = true }: {
  freshness: Freshness; asOf?: number; showAge?: boolean;
}) {
  // Nothing to re-compute for a server-authoritative label, and no age is rendered for
  // one either — so those chips never start a timer.
  const now = useNow(asOf !== undefined && !isServerAuthoritative(freshness));
  // Clamped: a tick that arrives a moment "in the future" reads as brand new, not negative.
  const ageMs = asOf === undefined ? undefined : Math.max(0, now - asOf);
  const effective = ageMs === undefined ? freshness : ageFreshness(freshness, ageMs);
  const s = STYLES[effective];
  return (
    <span className={`chip ${s.cls}`} title={ageMs !== undefined ? `Data received ${ago(ageMs)}` : undefined}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${effective === 'LIVE' ? 'animate-pulse' : ''}`} />
      {s.label}
      {showAge && ageMs !== undefined && !isServerAuthoritative(effective) && (
        <span className="opacity-60">· {ago(ageMs)}</span>
      )}
    </span>
  );
}
