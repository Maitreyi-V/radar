import { useEffect, useState } from 'react';
import { api, type CheckpointSummary } from '../api';

/**
 * The memory, made browsable.
 *
 * Each checkpoint is a moment the user said "I've seen this". Listing them turns an
 * invisible internal record into the product's central promise: it really is keeping
 * track of when you looked.
 */
export function VisitHistory({ watchlistId, currentSince }: { watchlistId: string; currentSince: number | null }) {
  const [items, setItems] = useState<CheckpointSummary[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.checkpoints(watchlistId).then((r) => setItems(r.checkpoints)).catch(() => setItems([]));
  }, [open, watchlistId, currentSince]);

  return (
    <div className="card overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300">
        <span>🕘</span> Your visit history
        <span className="ml-auto text-slate-600">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="border-t border-ink-800 divide-y divide-ink-850">
          {items.length === 0 && <p className="px-4 py-3 text-xs text-slate-600">No visits recorded yet.</p>}
          {items.map((c) => (
            <div key={c.id} className="px-4 py-2.5 flex items-center justify-between text-xs">
              <span className={c.takenAt === currentSince ? 'text-accent' : 'text-slate-400'}>
                {new Date(c.takenAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}
                {c.takenAt === currentSince && <span className="ml-2 text-[10px] uppercase tracking-wide">current anchor</span>}
              </span>
              <span className="text-slate-600 num">{c.symbols} symbols</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
