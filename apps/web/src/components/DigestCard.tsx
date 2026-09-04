import type { DigestCard as Card } from '../api';
import { inr, pct, shortSymbol } from '../format';
import { FreshnessChip } from './FreshnessChip';

/** Human labels for event types — no unexplained badges anywhere in this UI. */
const EVENT_LABEL: Record<string, string> = {
  VOLATILITY_MOVE: 'Unusual move',
  VOLUME_SPIKE: 'Volume spike',
  BREACH_52W: '52-week level',
  GAP_OPEN: 'Gap open',
  STREAK: 'Streak',
  REF_DRAWDOWN: 'Since you added',
};

export function DigestCardView({ card, rank, onOpen }: {
  card: Card; rank: number; onOpen: (symbol: string) => void;
}) {
  const up = (card.changePct ?? 0) >= 0;
  return (
    <button
      onClick={() => onOpen(card.symbol)}
      className="card w-full text-left p-4 hover:border-ink-600 transition-colors group"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className="mt-0.5 w-6 h-6 shrink-0 rounded-md bg-ink-800 text-slate-400 text-xs font-semibold grid place-items-center">
            {rank}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-100">{shortSymbol(card.symbol)}</span>
              <span className="text-xs text-slate-500 truncate">{card.name}</span>
            </div>
            {/* The explainability rule: one plain sentence, with its numbers. */}
            <p className="mt-1.5 text-sm text-slate-300 leading-relaxed">{card.headline}</p>
            {card.supporting.map((s, i) => (
              <p key={i} className="mt-1 text-sm text-slate-400 leading-relaxed">{s}</p>
            ))}
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="num text-slate-100 font-semibold">₹{inr(card.price)}</div>
          <div className={`num text-sm font-medium ${up ? 'text-up' : 'text-down'}`}>{pct(card.changePct)}</div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {card.events.map((e) => (
          <span key={e.dedupKey} className="chip bg-ink-800 text-slate-400">
            {EVENT_LABEL[e.type] ?? e.type}
            <span className="opacity-50">· {e.score.toFixed(1)}</span>
          </span>
        ))}
        <span className="ml-auto"><FreshnessChip freshness={card.freshness} showAge={false} /></span>
      </div>
    </button>
  );
}
