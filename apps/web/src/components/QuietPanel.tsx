import { useState } from 'react';
import type { QuietDetail } from '../api';
import { shortSymbol, pct } from '../format';
import { NormalityGauge } from './NormalityGauge';

/**
 * The negative case, in plain language.
 *
 * Any watchlist can claim "nothing important happened". Almost none can show you why.
 * This does — but it must do so in words a retail investor actually uses. The default
 * view is a sentence and a picture; the statistics sit behind "show the math" for anyone
 * who wants to check the working (and for the reviewer who asks how the ranking is
 * computed). Leading with sigma would be precise and useless.
 */
export function QuietPanel({ count, detail, sensitivity }: {
  count: number; detail: QuietDetail[]; sensitivity: number;
}) {
  const [open, setOpen] = useState(false);
  const [math, setMath] = useState(false);
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
          <div className="px-4 py-3 flex items-start justify-between gap-4 bg-ink-850/40">
            <p className="text-xs text-slate-500 leading-relaxed max-w-2xl">
              These all moved a bit — but not by much <em>for them</em>. Every stock has its own
              normal: a 2% day is dramatic for HDFC Bank and an ordinary Tuesday for Paytm. The bar
              shows each stock's usual daily range, and the dot shows where today landed.
            </p>
            <button onClick={() => setMath(!math)}
              className="shrink-0 text-[11px] text-slate-600 hover:text-slate-400 underline decoration-dotted">
              {math ? 'hide the math' : 'show the math'}
            </button>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-600 border-b border-ink-850">
                <th className="text-left px-4 py-2 font-medium">Stock</th>
                <th className="text-right px-4 py-2 font-medium">Today</th>
                <th className="text-left px-4 py-2 font-medium">Normal range</th>
                <th className="text-left px-4 py-2 font-medium">What that means</th>
                {math && <>
                  <th className="text-right px-3 py-2 font-medium">σ/day</th>
                  <th className="text-right px-4 py-2 font-medium">z</th>
                </>}
              </tr>
            </thead>
            <tbody>
              {detail.map((d) => (
                <tr key={d.symbol} className="border-b border-ink-850 last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="text-slate-300">{shortSymbol(d.symbol)}</span>
                    <span className="block text-[11px] text-slate-600 truncate max-w-[150px]">{d.name}</span>
                  </td>
                  <td className={`px-4 py-2.5 text-right num ${(d.changePct ?? 0) >= 0 ? 'text-up/70' : 'text-down/70'}`}>
                    {pct(d.changePct)}
                  </td>
                  <td className="px-4 py-2.5">
                    <NormalityGauge z={d.z} sensitivity={sensitivity} />
                    <span className="block text-[10px] text-slate-600 mt-0.5">
                      {d.sigmaPct === null ? 'unknown' : `usually ±${d.sigmaPct.toFixed(1)}% a day`}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{d.reason}</td>
                  {math && <>
                    <td className="px-3 py-2.5 text-right num text-slate-600 text-xs">
                      {d.sigmaPct === null ? '—' : `${d.sigmaPct.toFixed(2)}%`}
                    </td>
                    <td className="px-4 py-2.5 text-right num text-slate-500 text-xs">
                      {d.z === null ? '—' : `${d.z.toFixed(2)}σ`}
                    </td>
                  </>}
                </tr>
              ))}
            </tbody>
          </table>

          {math && (
            <p className="px-4 py-2.5 text-[11px] text-slate-600 border-t border-ink-850">
              σ is the stock's own 30-day daily-return standard deviation; z is today's move
              divided by it. A stock surfaces at |z| ≥ {sensitivity}. This is what the plain-English
              column above is describing.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
