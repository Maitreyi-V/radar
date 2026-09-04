import { useState } from 'react';
import type { QuietDetail } from '../api';
import { shortSymbol, pct } from '../format';

/**
 * The negative case, made auditable.
 *
 * Every watchlist can claim "nothing important happened". Almost none can show you the
 * arithmetic behind that claim. Expanding this row reveals, for each quiet stock, how far
 * it actually moved, what its own normal day looks like, and the resulting z-score — so
 * "quiet" is a checkable statement rather than something you take on trust.
 *
 * It is also the clearest possible explanation of the product's core idea: read the σ
 * column and you can see why a 2% mover was ignored while a 1.3% mover was surfaced.
 */
export function QuietPanel({ count, detail, sensitivity }: {
  count: number; detail: QuietDetail[]; sensitivity: number;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex items-center gap-2 text-sm text-slate-500 hover:text-slate-300 transition-colors"
      >
        <span className="text-slate-600">—</span>
        Nothing unusual in {count} other stock{count === 1 ? '' : 's'}
        <span className="ml-auto text-xs text-slate-600">
          {open ? 'hide' : 'why?'} <span className="inline-block ml-0.5">{open ? '▲' : '▼'}</span>
        </span>
      </button>

      {open && (
        <div className="border-t border-ink-800">
          <div className="px-4 py-2.5 text-[11px] text-slate-500 bg-ink-850/40">
            Each of these moved less than <span className="text-slate-300 num">{sensitivity}</span> in
            score terms. A move is judged against <em>that stock's own</em> normal day (σ), not a
            fixed percentage — which is why a bigger % move can rank below a smaller one.
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-600 border-b border-ink-850">
                <th className="text-left px-4 py-2 font-medium">Symbol</th>
                <th className="text-right px-4 py-2 font-medium">Moved</th>
                <th className="text-right px-4 py-2 font-medium">Its own σ</th>
                <th className="text-right px-4 py-2 font-medium">z-score</th>
                <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {detail.map((d) => (
                <tr key={d.symbol} className="border-b border-ink-850 last:border-0">
                  <td className="px-4 py-2">
                    <span className="text-slate-300">{shortSymbol(d.symbol)}</span>
                    <span className="block text-[11px] text-slate-600 truncate max-w-[160px]">{d.name}</span>
                  </td>
                  <td className={`px-4 py-2 text-right num ${(d.changePct ?? 0) >= 0 ? 'text-up/70' : 'text-down/70'}`}>
                    {pct(d.changePct)}
                  </td>
                  <td className="px-4 py-2 text-right num text-slate-500">
                    {d.sigmaPct === null ? '—' : `±${d.sigmaPct.toFixed(2)}%`}
                  </td>
                  <td className="px-4 py-2 text-right num text-slate-400">
                    {d.z === null ? '—' : `${d.z.toFixed(2)}σ`}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600 hidden md:table-cell">{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
