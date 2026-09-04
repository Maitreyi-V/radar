import { useEffect, useState } from 'react';
import { api, type ReplayStatus, type ReplaySession } from '../api';
import { istTime } from '../format';

const SPEEDS = [1, 30, 60, 120, 300, 600];

/**
 * Replay controls.
 *
 * The pitch, in one line on screen: the judging window is mostly market-closed, so we
 * recorded a real session and can re-run it on demand. Replayed ticks travel the same
 * ingestion -> SSE -> digest path as live ones, so what you watch reshape is the real
 * engine, not a canned animation.
 */
export function ReplayBar({ onTick }: { onTick: () => void }) {
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [sessions, setSessions] = useState<ReplaySession[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.replayStatus();
      setStatus(r.status); setSessions(r.sessions);
    } catch { /* leave the last known status on screen */ }
  };

  useEffect(() => { void load(); }, []);

  // Poll only while a replay is actually moving.
  useEffect(() => {
    if (status?.state !== 'running') return;
    const t = setInterval(() => { void load(); onTick(); }, 1200);
    return () => clearInterval(t);
  }, [status?.state, onTick]);

  const act = async (fn: () => Promise<{ status: ReplayStatus }>) => {
    setBusy(true); setErr(null);
    try { setStatus((await fn()).status); onTick(); }
    catch (e: any) { setErr(e.message ?? 'Replay failed'); }
    finally { setBusy(false); }
  };

  if (!status) return null;

  const running = status.state === 'running';
  const paused = status.state === 'paused';
  const pct = status.totalSteps > 0 ? (status.step / status.totalSteps) * 100 : 0;
  const session = sessions[0];

  return (
    <div className="card p-3.5">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${running ? 'bg-accent animate-pulse' : 'bg-slate-600'}`} />
          <span className="text-sm font-medium text-slate-200">Market Replay</span>
        </div>

        <span className="text-xs text-slate-500">
          {session
            ? `${session.sessionDate} · ${session.ticks.toLocaleString('en-IN')} recorded ticks · ${session.symbols} symbols`
            : 'no recorded session'}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={status.speed}
            onChange={(e) => void act(() => api.replaySpeed(Number(e.target.value)))}
            disabled={busy}
            className="bg-ink-950 border border-ink-700 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-accent"
          >
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>

          {!running && !paused && (
            <button disabled={busy || !session} onClick={() => void act(() => api.replayStart(status.speed))}
              className="btn-primary text-xs px-3 py-1.5">Replay the day</button>
          )}
          {running && (
            <button disabled={busy} onClick={() => void act(api.replayPause)}
              className="btn-ghost text-xs px-3 py-1.5">Pause</button>
          )}
          {paused && (
            <button disabled={busy} onClick={() => void act(api.replayResume)}
              className="btn-primary text-xs px-3 py-1.5">Resume</button>
          )}
          {(running || paused || status.state === 'finished' || status.emitted > 0) && (
            <button disabled={busy} onClick={() => void act(api.replayReset)}
              className="btn-ghost text-xs px-3 py-1.5" title="Delete replayed ticks and restore real data">
              Reset
            </button>
          )}
        </div>
      </div>

      {(running || paused || status.state === 'finished') && (
        <div className="mt-3">
          <div className="h-1 bg-ink-800 rounded-full overflow-hidden">
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500">
            <span>
              market clock {status.simulatedAt ? istTime(status.simulatedAt) : '—'} IST
              <span className="ml-2 opacity-60">· {status.emitted.toLocaleString('en-IN')} ticks replayed</span>
            </span>
            <span>{status.step}/{status.totalSteps} {status.state === 'finished' ? '· session complete' : ''}</span>
          </div>
        </div>
      )}

      {err && <p className="mt-2 text-xs text-down">{err}</p>}
    </div>
  );
}
