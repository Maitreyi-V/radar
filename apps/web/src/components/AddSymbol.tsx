import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { shortSymbol } from '../format';

/** Debounced typeahead — one request per pause in typing, not one per keystroke. */
export function AddSymbol({ onAdd, existing }: { onAdd: (symbol: string) => void; existing: string[] }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ symbol: string; name: string }>>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 1) { setResults([]); return; }
    const t = setTimeout(async () => {
      try { setResults((await api.search(q)).results); setOpen(true); } catch { /* keep last results */ }
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <div ref={box} className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        placeholder="Add a stock…"
        className="w-56 bg-ink-900 border border-ink-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent placeholder:text-slate-600"
      />
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-80 card p-1 max-h-72 overflow-y-auto shadow-2xl">
          {results.map((r) => {
            const already = existing.includes(r.symbol);
            return (
              <button key={r.symbol} disabled={already}
                onClick={() => { onAdd(r.symbol); setQ(''); setOpen(false); }}
                className="w-full text-left px-2.5 py-2 rounded-md hover:bg-ink-800 disabled:opacity-40 flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="text-sm text-slate-200 font-medium">{shortSymbol(r.symbol)}</span>
                  <span className="block text-xs text-slate-500 truncate">{r.name}</span>
                </span>
                <span className="text-[11px] text-slate-500 shrink-0">{already ? 'added' : '+'}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
