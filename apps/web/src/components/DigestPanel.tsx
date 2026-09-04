import type { Digest } from '../api';
import { shortSymbol } from '../format';
import { DigestCardView } from './DigestCard';
import { QuietPanel } from './QuietPanel';

/**
 * The hero moment: "Since you left".
 *
 * Two states matter equally. When something happened, we show at most 5 ranked cards,
 * each with a plain-English reason. When nothing did, we say so plainly rather than
 * padding the list — a watchlist that can honestly say "nothing to see" is more
 * trustworthy than one that always screams.
 */
export function DigestPanel({ digest, onOpen, onCaughtUp, busy }: {
  digest: Digest; onOpen: (s: string) => void; onCaughtUp: () => void; busy: boolean;
}) {
  return (
    <section>
      <header className="flex items-end justify-between gap-4 mb-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            {digest.since === null ? 'Welcome to Radar' : 'Since you left'}
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {digest.since === null
              ? 'Add a few stocks, then mark yourself caught up. Next time you return, this is where what changed will appear.'
              : `You were last here ${digest.sinceLabel}.`}
          </p>
        </div>
        <button onClick={onCaughtUp} disabled={busy} className="btn-ghost shrink-0">
          {busy ? 'Saving…' : "Mark caught up"}
        </button>
      </header>

      {digest.isQuiet ? (
        <div className="card p-8 text-center">
          <div className="text-2xl mb-2">✓</div>
          <p className="text-slate-200 font-medium">Quiet since you left.</p>
          <p className="mt-1 text-sm text-slate-500">
            Nothing crossed the threshold that would make it worth your attention.
            {digest.quietCount > 0 && ` We checked ${digest.quietCount} stock${digest.quietCount === 1 ? '' : 's'}.`}
          </p>
          <div className="mt-4 text-left">
            <QuietPanel count={digest.quietCount} detail={digest.quietDetail} sensitivity={digest.sensitivity} />
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          {digest.cards.map((c, i) => (
            <DigestCardView key={c.symbol} card={c} rank={i + 1} onOpen={onOpen} />
          ))}

          <QuietPanel count={digest.quietCount} detail={digest.quietDetail} sensitivity={digest.sensitivity} />
        </div>
      )}

      {digest.unconfirmed.length > 0 && (
        <div className="mt-3 card px-4 py-2.5 border-amber-500/20 bg-amber-500/5">
          <p className="text-xs text-amber-300">
            <strong>Unconfirmed price</strong> for {digest.unconfirmed.map((u) => u.symbol.replace(/\.(NS|BO)$/, '')).join(', ')} —
            two providers disagree. Showing the last confirmed value and re-polling.
          </p>
          <p className="text-[11px] text-amber-300/60 mt-1">{digest.unconfirmed[0]!.reason}</p>
        </div>
      )}

      {digest.unavailable.length > 0 && (
        <p className="mt-3 text-xs text-amber-400/80">
          No price data yet for {digest.unavailable.map(shortSymbol).join(', ')} — surfaced rather than hidden.
        </p>
      )}
    </section>
  );
}
