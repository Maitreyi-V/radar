import type { QuoteView } from '../api';
import { inr, pct, compact, shortSymbol } from '../format';
import { FreshnessChip } from './FreshnessChip';
import { Sparkline } from './Sparkline';

export function WatchlistTable({ quotes, onRemove, onOpen, flash }: {
  quotes: QuoteView[];
  onRemove: (symbol: string) => void;
  onOpen: (symbol: string) => void;
  flash: Record<string, 'up' | 'down' | undefined>;
}) {
  if (quotes.length === 0) {
    return (
      <div className="card p-10 text-center">
        <p className="text-slate-300 font-medium">Your watchlist is empty</p>
        <p className="mt-1 text-sm text-slate-500">Search for a stock above to start tracking it.</p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-800">
            <th className="px-4 py-2.5 font-medium">Symbol</th>
            <th className="px-4 py-2.5 font-medium text-right">Price</th>
            <th className="px-4 py-2.5 font-medium text-right">Day</th>
            <th className="px-4 py-2.5 font-medium text-right hidden md:table-cell">Since added</th>
            <th className="px-4 py-2.5 font-medium text-right hidden lg:table-cell">Volume</th>
            <th className="px-4 py-2.5 font-medium hidden sm:table-cell">Trend</th>
            <th className="px-4 py-2.5 font-medium">Data</th>
            <th className="px-2 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {quotes.map((q) => {
            const up = (q.changePct ?? 0) >= 0;
            const f = flash[q.symbol];
            return (
              <tr key={q.symbol}
                  className={`border-b border-ink-850 last:border-0 hover:bg-ink-850/50 transition-colors
                    ${f === 'up' ? 'bg-up/5' : f === 'down' ? 'bg-down/5' : ''}`}>
                <td className="px-4 py-3">
                  <button onClick={() => onOpen(q.symbol)} className="text-left group">
                    <div className="font-medium text-slate-100 group-hover:text-accent transition-colors">
                      {shortSymbol(q.symbol)}
                    </div>
                    <div className="text-xs text-slate-500 truncate max-w-[180px]">{q.name}</div>
                  </button>
                </td>
                <td className="px-4 py-3 text-right num text-slate-100">₹{inr(q.price)}</td>
                <td className={`px-4 py-3 text-right num font-medium ${up ? 'text-up' : 'text-down'}`}>{pct(q.changePct)}</td>
                <td className={`px-4 py-3 text-right num hidden md:table-cell ${(q.refChangePct ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                  {pct(q.refChangePct)}
                </td>
                <td className="px-4 py-3 text-right num text-slate-400 hidden lg:table-cell">{compact(q.volume)}</td>
                <td className="px-4 py-3 hidden sm:table-cell"><Sparkline points={q.sparkline} direction={q.changePct} /></td>
                <td className="px-4 py-3"><FreshnessChip freshness={q.freshness} ageMs={q.ageMs} /></td>
                <td className="px-2 py-3 text-right">
                  <button onClick={() => onRemove(q.symbol)}
                    className="text-slate-600 hover:text-down px-2 text-lg leading-none" title="Remove">×</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
