import { db } from '../db/index.js';
import { writeQuote } from '../ingestion/store.js';
import type { Quote } from '../ingestion/types.js';
import { sleep } from '../ingestion/rateLimiter.js';

/**
 * Replay engine — plays a recorded trading session back through the SAME pipeline.
 *
 * Why this exists: the judging window is Fri 11:00 -> Mon 11:00, so for ~65 of those 72
 * hours the market is shut and a live-price watchlist demos as a dead screen. Replay
 * turns that from a problem into the feature: we recorded Friday's real session and can
 * re-run it, at speed, at any hour of the weekend.
 *
 * The important design property: replayed ticks go through `writeQuote` and out over SSE
 * exactly like live ticks. The significance engine, the digest and the UI cannot tell the
 * difference — so the demo exercises the real system rather than a mock of it.
 *
 * Replayed rows are written under source='replay', which keeps the recorded tape
 * pristine and makes a reset a single DELETE.
 */
export const REPLAY_SOURCE = 'replay';

export type ReplayState = 'idle' | 'running' | 'paused' | 'finished';

export interface ReplayStatus {
  state: ReplayState;
  speed: number;
  sessionDate: string | null;
  /** Index into the tape's distinct timestamps. */
  step: number;
  totalSteps: number;
  /** The simulated market clock, as epoch ms of the original session. */
  simulatedAt: number | null;
  symbols: number;
  emitted: number;
}

interface TapeRow {
  symbol: string; price: number; volume: number | null;
  day_high: number | null; day_low: number | null; day_open: number | null;
  prev_close: number | null; week52_high: number | null; week52_low: number | null;
  as_of: number;
}

export class ReplayEngine {
  private state: ReplayState = 'idle';
  private speed = 60;
  private sessionDate: string | null = null;
  private step = 0;
  private steps: number[] = [];
  private byTime = new Map<number, TapeRow[]>();
  private emitted = 0;
  private runToken = 0;
  private listeners: Array<(q: Quote) => void> = [];

  onQuote(fn: (q: Quote) => void): void { this.listeners.push(fn); }

  /** Sessions available to replay, newest first. */
  static availableSessions(): Array<{ sessionDate: string; ticks: number; symbols: number }> {
    return db.prepare(`
      SELECT session_date AS sessionDate, COUNT(*) AS ticks, COUNT(DISTINCT symbol) AS symbols
      FROM quotes WHERE source = 'bse-intraday' AND session_date IS NOT NULL
      GROUP BY session_date ORDER BY session_date DESC
    `).all() as Array<{ sessionDate: string; ticks: number; symbols: number }>;
  }

  private load(sessionDate: string): void {
    const rows = db.prepare(`
      SELECT symbol, price, volume, day_high, day_low, day_open, prev_close,
             week52_high, week52_low, as_of
      FROM quotes
      WHERE source = 'bse-intraday' AND session_date = ?
      ORDER BY as_of ASC
    `).all(sessionDate) as TapeRow[];

    this.byTime.clear();
    for (const r of rows) {
      const bucket = this.byTime.get(r.as_of);
      if (bucket) bucket.push(r);
      else this.byTime.set(r.as_of, [r]);
    }
    this.steps = [...this.byTime.keys()].sort((a, b) => a - b);
  }

  async start(opts: { sessionDate?: string; speed?: number; fromStep?: number } = {}): Promise<ReplayStatus> {
    this.stop();                                  // cancel any run already in flight
    const session = opts.sessionDate ?? ReplayEngine.availableSessions()[0]?.sessionDate;
    if (!session) throw new Error('no recorded session available to replay');

    this.sessionDate = session;
    this.speed = clampSpeed(opts.speed ?? 60);
    this.load(session);
    if (this.steps.length === 0) throw new Error(`no ticks recorded for ${session}`);

    this.step = opts.fromStep ?? 0;
    this.emitted = 0;
    this.state = 'running';
    const token = ++this.runToken;
    void this.run(token);
    return this.status();
  }

  private async run(token: number): Promise<void> {
    while (token === this.runToken && this.step < this.steps.length) {
      if (this.state !== 'running') { await sleep(120); continue; }

      const at = this.steps[this.step]!;
      const rows = this.byTime.get(at) ?? [];
      const now = Date.now();

      for (const r of rows) {
        const q: Quote = {
          symbol: r.symbol, price: r.price, volume: r.volume,
          dayHigh: r.day_high, dayLow: r.day_low, dayOpen: r.day_open,
          prevClose: r.prev_close, week52High: r.week52_high, week52Low: r.week52_low,
          // Stamped with wall-clock NOW so the tick reads as current to the freshness
          // contract and the digest; the original market time is preserved in `simulatedAt`.
          asOf: now, fetchedAt: now,
          source: REPLAY_SOURCE, isSynthetic: false,
        };
        writeQuote(q);
        this.emitted++;
        for (const fn of this.listeners) { try { fn(q); } catch { /* a listener must not stall replay */ } }
      }

      this.step++;
      const next = this.steps[this.step];
      if (next === undefined) break;

      // Compress the original inter-tick gap by the speed factor.
      const gap = Math.max(0, next - at) / this.speed;
      await sleep(Math.min(2_000, Math.max(15, gap)));
    }
    if (token === this.runToken) this.state = 'finished';
  }

  pause(): ReplayStatus { if (this.state === 'running') this.state = 'paused'; return this.status(); }
  resume(): ReplayStatus { if (this.state === 'paused') this.state = 'running'; return this.status(); }

  stop(): ReplayStatus {
    this.runToken++;                              // invalidates any in-flight loop
    this.state = 'idle';
    return this.status();
  }

  setSpeed(speed: number): ReplayStatus { this.speed = clampSpeed(speed); return this.status(); }

  /** Remove every replayed row, restoring the view to real recorded data. */
  reset(): ReplayStatus {
    this.stop();
    db.prepare(`DELETE FROM quotes WHERE source = ?`).run(REPLAY_SOURCE);
    this.step = 0; this.emitted = 0; this.state = 'idle';
    return this.status();
  }

  status(): ReplayStatus {
    return {
      state: this.state,
      speed: this.speed,
      sessionDate: this.sessionDate,
      step: this.step,
      totalSteps: this.steps.length,
      simulatedAt: this.steps[Math.min(this.step, this.steps.length - 1)] ?? null,
      symbols: new Set([...this.byTime.values()].flat().map((r) => r.symbol)).size,
      emitted: this.emitted,
    };
  }
}

const clampSpeed = (s: number): number => Math.min(600, Math.max(1, Math.round(s) || 1));

/**
 * Clear stranded replay rows left behind by a previous process.
 *
 * Replayed ticks are written to the database so they flow through the real read path,
 * but the engine's progress lives in memory. A crash or restart therefore leaves rows
 * with no engine to own them: the UI keeps rendering REPLAY prices while the engine
 * reports 'idle', and the Reset control — which only appears while a replay is active —
 * is unreachable. The user is stuck looking at simulated data with no way out.
 *
 * Replay output is a demo artifact and must never outlive the process that produced it,
 * so we clear it at boot. Recorded and live rows are untouched.
 */
export function clearStrandedReplayRows(): number {
  const info = db.prepare(`DELETE FROM quotes WHERE source = ?`).run(REPLAY_SOURCE);
  return info.changes;
}

export const replay = new ReplayEngine();
