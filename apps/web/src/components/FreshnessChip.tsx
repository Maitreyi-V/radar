import type { Freshness } from '../api';
import { ago } from '../format';

/**
 * The honesty-first UI element.
 *
 * Every price on screen carries its own age. Most watchlists render a stale number with
 * no indication it is stale, which is a quiet lie. Showing the age — and saying
 * MARKET CLOSED plainly when nothing is trading — is a deliberate product stance.
 */
const STYLES: Record<Freshness, { label: string; cls: string; dot: string }> = {
  LIVE:          { label: 'LIVE',          cls: 'bg-up/10 text-up',                 dot: 'bg-up' },
  DELAYED:       { label: 'DELAYED',       cls: 'bg-amber-500/10 text-amber-400',   dot: 'bg-amber-400' },
  STALE:         { label: 'STALE',         cls: 'bg-down/10 text-down',             dot: 'bg-down' },
  MARKET_CLOSED: { label: 'MARKET CLOSED', cls: 'bg-slate-500/10 text-slate-400',   dot: 'bg-slate-500' },
  // Replayed ticks are genuinely fresh, so an age check alone would call them LIVE.
  // They are labelled distinctly because presenting a recording as live market data
  // is precisely the kind of quiet lie this product refuses to tell.
  REPLAY:        { label: 'REPLAY',        cls: 'bg-accent/10 text-accent',         dot: 'bg-accent' },
};

export function FreshnessChip({ freshness, ageMs, showAge = true }: {
  freshness: Freshness; ageMs?: number; showAge?: boolean;
}) {
  const s = STYLES[freshness];
  return (
    <span className={`chip ${s.cls}`} title={ageMs !== undefined ? `Data received ${ago(ageMs)}` : undefined}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${freshness === 'LIVE' ? 'animate-pulse' : ''}`} />
      {s.label}
      {showAge && ageMs !== undefined && freshness !== 'MARKET_CLOSED' && freshness !== 'REPLAY' && (
        <span className="opacity-60">· {ago(ageMs)}</span>
      )}
    </span>
  );
}
