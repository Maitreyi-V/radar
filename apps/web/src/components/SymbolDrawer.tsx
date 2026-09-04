import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { api, type QuoteView, type StoredEvent } from '../api';
import { inr, pct, istTime, shortSymbol, compact } from '../format';

/** Drill-down: intraday chart with the checkpoint marked "you were here". */
export function SymbolDrawer({ symbol, quote, checkpointAt, onClose }: {
  symbol: string; quote?: QuoteView; checkpointAt: number | null; onClose: () => void;
}) {
  const [points, setPoints] = useState<Array<{ asOf: number; price: number }>>([]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.history(symbol)
      .then((r) => { if (alive) setPoints(r.points); })
      .catch(() => { if (alive) setPoints([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol]);

  // Event timeline: what actually fired on this symbol, and when.
  useEffect(() => {
    let alive = true;
    api.symbolEvents(symbol, checkpointAt ?? 0)
      .then((r) => { if (alive) setEvents(r.events); })
      .catch(() => { if (alive) setEvents([]); });
    return () => { alive = false; };
  }, [symbol, checkpointAt]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const up = (quote?.changePct ?? 0) >= 0;

  return (
    <div className="fixed inset-0 z-30 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-ink-900 border-l border-ink-800 h-full overflow-y-auto">
        <header className="sticky top-0 bg-ink-900/95 backdrop-blur border-b border-ink-800 px-5 py-4 flex items-start justify-between">
          <div>
            <h3 className="text-xl font-semibold text-slate-100">{shortSymbol(symbol)}</h3>
            <p className="text-sm text-slate-500">{quote?.name}</p>
          </div>
          <div className="flex items-start gap-4">
            {quote && (
              <div className="text-right">
                <div className="num text-lg text-slate-100">₹{inr(quote.price)}</div>
                <div className={`num text-sm ${up ? 'text-up' : 'text-down'}`}>{pct(quote.changePct)}</div>
              </div>
            )}
            <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-2xl leading-none">×</button>
          </div>
        </header>

        <div className="p-5 space-y-5">
          <div className="card p-4">
            <div className="text-xs text-slate-500 mb-3">
              Intraday · {points.length} points
              {checkpointAt && <span className="ml-2 text-accent">▏ dashed line = you were here</span>}
            </div>
            <div className="h-56">
              {loading ? (
                <div className="h-full grid place-items-center text-sm text-slate-600">Loading…</div>
              ) : points.length < 2 ? (
                <div className="h-full grid place-items-center text-sm text-slate-600">Not enough data yet</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <XAxis dataKey="asOf" tickFormatter={istTime} stroke="#3a4356" fontSize={11}
                           tick={{ fill: '#64748b' }} minTickGap={40} />
                    <YAxis domain={['dataMin', 'dataMax']} stroke="#3a4356" fontSize={11}
                           tick={{ fill: '#64748b' }} width={58} tickFormatter={(v) => inr(v)} />
                    <Tooltip
                      contentStyle={{ background: '#141821', border: '1px solid #262d3d', borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(v) => istTime(Number(v))}
                      formatter={(v) => [`₹${inr(Number(v))}`, 'Price']} />
                    {checkpointAt && <ReferenceLine x={checkpointAt} stroke="#5b8cff" strokeDasharray="4 4" />}
                    <Line type="monotone" dataKey="price" dot={false} strokeWidth={1.8}
                          stroke={up ? '#00c48c' : '#ff5c5c'} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="card p-4">
            <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-3">
              Event timeline {checkpointAt ? '· since you were last here' : ''}
            </h4>
            {events.length === 0 ? (
              <p className="text-sm text-slate-600">
                Nothing has crossed the threshold for this stock. That is a finding, not a gap.
              </p>
            ) : (
              <ol className="space-y-2.5">
                {events.map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="mt-1 w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm text-slate-300 leading-snug">{e.explanation}</p>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        {new Date(e.occurredAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}
                        <span className="ml-2">score {e.score.toFixed(1)}</span>
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {quote && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              <Stat label="Open" value={quote.dayOpen ? `₹${inr(quote.dayOpen)}` : '—'} />
              <Stat label="Prev close" value={quote.prevClose ? `₹${inr(quote.prevClose)}` : '—'} />
              <Stat label="Day range" value={quote.dayLow && quote.dayHigh ? `${inr(quote.dayLow)} – ${inr(quote.dayHigh)}` : '—'} />
              <Stat label="52w high" value={quote.week52High ? `₹${inr(quote.week52High)}` : '—'} />
              <Stat label="52w low" value={quote.week52Low ? `₹${inr(quote.week52Low)}` : '—'} />
              <Stat label="Volume" value={compact(quote.volume)} />
              <Stat label="You added at" value={quote.refPrice ? `₹${inr(quote.refPrice)}` : '—'} />
              <Stat label="Since added" value={pct(quote.refChangePct)} />
              <Stat label="Source" value={quote.source} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="num text-sm text-slate-200 mt-0.5">{value}</div>
    </div>
  );
}
