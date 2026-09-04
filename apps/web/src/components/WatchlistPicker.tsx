import { useEffect, useRef, useState } from 'react';
import type { Watchlist } from '../api';

/** Switch, create, rename and delete watchlists. */
export function WatchlistPicker({ watchlists, activeId, onSwitch, onCreate, onRename, onDelete }: {
  watchlists: Watchlist[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setOpen(false); setCreating(false); setEditing(null); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const active = watchlists.find((w) => w.id === activeId);

  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-ink-900 border border-ink-700 hover:border-ink-600 text-sm">
        <span className="text-slate-200 truncate max-w-[160px]">{active?.name ?? 'Watchlist'}</span>
        <span className="text-[11px] text-slate-500">{active?.symbols.length ?? 0}</span>
        <span className="text-slate-600 text-xs">▾</span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-72 card p-1 shadow-2xl">
          {watchlists.map((w) => (
            <div key={w.id} className="group flex items-center gap-1 rounded-md hover:bg-ink-800">
              {editing === w.id ? (
                <input
                  autoFocus defaultValue={w.name}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { onRename(w.id, (e.target as HTMLInputElement).value); setEditing(null); }
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  onBlur={() => setEditing(null)}
                  className="flex-1 bg-ink-950 border border-accent rounded-md px-2 py-1.5 text-sm outline-none"
                />
              ) : (
                <>
                  <button onClick={() => { onSwitch(w.id); setOpen(false); }}
                    className="flex-1 text-left px-2.5 py-2 min-w-0">
                    <span className={`text-sm ${w.id === activeId ? 'text-accent' : 'text-slate-200'}`}>{w.name}</span>
                    <span className="block text-[11px] text-slate-600">{w.symbols.length} symbols</span>
                  </button>
                  <button onClick={() => setEditing(w.id)} title="Rename"
                    className="opacity-0 group-hover:opacity-100 px-1.5 text-slate-500 hover:text-slate-200 text-xs">✎</button>
                  {watchlists.length > 1 && (
                    <button onClick={() => { onDelete(w.id); setOpen(false); }} title="Delete"
                      className="opacity-0 group-hover:opacity-100 px-2 text-slate-600 hover:text-down">×</button>
                  )}
                </>
              )}
            </div>
          ))}

          <div className="border-t border-ink-800 mt-1 pt-1">
            {creating ? (
              <input
                autoFocus value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draft.trim()) { onCreate(draft.trim()); setDraft(''); setCreating(false); setOpen(false); }
                  if (e.key === 'Escape') { setCreating(false); setDraft(''); }
                }}
                placeholder="New watchlist name…"
                className="w-full bg-ink-950 border border-accent rounded-md px-2.5 py-2 text-sm outline-none placeholder:text-slate-600"
              />
            ) : (
              <button onClick={() => setCreating(true)}
                className="w-full text-left px-2.5 py-2 text-sm text-slate-400 hover:text-slate-200 hover:bg-ink-800 rounded-md">
                + New watchlist
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
