import { db } from '../db/index.js';
import type { Bar } from '../significance/stats.js';
import type { SymbolContext } from '../significance/types.js';
import { detectAll, short } from '../significance/detectors.js';
import { rank, ATTENTION_THRESHOLD, type ScoredEvent } from '../significance/score.js';
import { volatility } from '../significance/stats.js';
import type { Digest, DigestCard, Freshness } from './types.js';
import { marketPhase, sessionDate, lastSessionClose } from '../ingestion/marketCalendar.js';
import { STALENESS } from '../config.js';
import { recordEvents, recentDigestSymbols } from './events.js';
import { unconfirmed } from '../ingestion/conflict.js';

/**
 * Honest data-age label. We never render a price without saying how old it is —
 * and never present replayed data as live market data.
 *
 * REPLAY outranks every other state on purpose: a replayed tick genuinely IS fresh
 * (we produced it a moment ago), so the age check alone would happily call it LIVE.
 * That would be technically true and materially misleading, which is exactly the kind
 * of quiet lie this product exists to refuse.
 */
export function freshnessOf(asOf: number, now: number, source?: string): Freshness {
  if (source === 'replay') return 'REPLAY';
  if (marketPhase(now) !== 'OPEN') return 'MARKET_CLOSED';
  const age = now - asOf;
  if (age <= STALENESS.live) return 'LIVE';
  if (age <= STALENESS.delayed) return 'DELAYED';
  return 'STALE';
}

const barsStmt = db.prepare(
  `SELECT bar_date AS date, open, high, low, close, volume FROM daily_bars
   WHERE symbol = ? ORDER BY bar_date ASC`,
);
const latestStmt = db.prepare(
  `SELECT price, volume, day_open AS dayOpen, prev_close AS prevClose,
          week52_high AS week52High, week52_low AS week52Low, as_of AS asOf, source
   FROM quotes WHERE symbol = ? ORDER BY as_of DESC LIMIT 1`,
);
const itemsStmt = db.prepare(
  `SELECT wi.symbol, wi.ref_price AS refPrice, wi.added_at AS addedAt,
          COALESCE(s.name, wi.symbol) AS name
   FROM watchlist_items wi LEFT JOIN symbols s ON s.symbol = wi.symbol
   WHERE wi.watchlist_id = ? ORDER BY wi.added_at ASC`,
);
const checkpointStmt = db.prepare(
  `SELECT taken_at AS takenAt, snapshot FROM checkpoints
   WHERE watchlist_id = ? AND user_id = ? ORDER BY taken_at DESC LIMIT 1`,
);

interface ItemRow { symbol: string; refPrice: number | null; addedAt: number; name: string }
interface QuoteRow {
  price: number; volume: number | null; dayOpen: number | null; prevClose: number | null;
  week52High: number | null; week52Low: number | null; asOf: number; source: string;
}

/**
 * Build the "since you left" digest.
 *
 * Computed at READ time, on demand, never precomputed per user. Users are absent most
 * of the time, and computing digests for absent users is work nobody will ever read.
 * Everything here is a pure function of (quotes, daily_bars, checkpoint) — so a crash
 * mid-digest corrupts nothing; we simply recompute.
 */
export function buildDigest(opts: {
  userId: string;
  watchlistId: string;
  now?: number;
  limit?: number;
  recentDigestSymbols?: string[][];
  /** Attention threshold. Lower = more surfaces. Defaults to ATTENTION_THRESHOLD. */
  sensitivity?: number;
}): Digest {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 5;
  const sensitivity = opts.sensitivity ?? ATTENTION_THRESHOLD;

  const items = itemsStmt.all(opts.watchlistId) as ItemRow[];
  // Novelty damping needs the symbols surfaced in RECENT digests. Before events were
  // persisted this was always empty, so novelty() silently returned 1.0 for everything.
  const history = opts.recentDigestSymbols ?? recentDigestSymbols(opts.watchlistId);
  const cp = checkpointStmt.get(opts.watchlistId, opts.userId) as
    | { takenAt: number; snapshot: string }
    | undefined;

  const snapshot: Record<string, { price: number }> = cp ? safeParse(cp.snapshot) : {};

  // A digest built from replayed ticks must NOT write into the user's real event
  // history. Replay is a simulation; letting it record events would damp novelty for
  // symbols that never actually moved, corrupting future real digests. Read-only.
  let builtFromReplay = false;

  const cards: DigestCard[] = [];
  const quietSymbols: string[] = [];
  const quietDetail: Digest['quietDetail'] = [];
  const unavailable: string[] = [];

  for (const item of items) {
    const q = latestStmt.get(item.symbol) as QuoteRow | undefined;
    if (!q) { unavailable.push(item.symbol); continue; }   // surfaced, not silently dropped

    if (q.source === 'replay') builtFromReplay = true;

    const bars = barsStmt.all(item.symbol) as Bar[];
    const checkpointPrice = snapshot[item.symbol]?.price;

    const ctx: SymbolContext = {
      symbol: item.symbol,
      bars,
      price: q.price,
      volume: q.volume,
      dayOpen: q.dayOpen,
      prevClose: q.prevClose,
      week52High: q.week52High,
      week52Low: q.week52Low,
      asOf: q.asOf,
      checkpointPrice,
      checkpointAt: cp?.takenAt,
      refPrice: item.refPrice ?? undefined,
      sessionDate: sessionDate(q.asOf),
    };

    const scored = rank(detectAll(ctx), { now, recentDigestSymbols: history, threshold: sensitivity });

    if (scored.length === 0) {
      quietSymbols.push(item.symbol);
      // Record the arithmetic behind the silence, so the user can audit it.
      const sigma = volatility(bars, 30);
      const base = checkpointPrice ?? q.prevClose;
      const change = base && base > 0 ? ((q.price - base) / base) : null;
      const z = sigma !== null && change !== null ? change / sigma : null;
      quietDetail.push({
        symbol: item.symbol, name: item.name, price: q.price,
        changePct: change === null ? null : round2(change * 100),
        sigmaPct: sigma === null ? null : round2(sigma * 100),
        z: z === null ? null : round2(z),
        // Plain-English verdict. The z-score stays in the payload for anyone who wants
        // it, but the sentence a user reads must not require a statistics background.
        reason: sigma === null
          ? "we don't have enough history for this stock yet"
          : z === null
            ? 'no earlier price to compare against'
            : plainVerdict(z),
      });
      continue;
    }

    const base = checkpointPrice ?? q.prevClose;
    cards.push({
      symbol: item.symbol,
      name: item.name,
      price: q.price,
      changePct: base && base > 0 ? round2(((q.price - base) / base) * 100) : null,
      events: scored,
      headline: scored[0]!.explanation,
      supporting: scored.slice(1).map((e) => e.explanation),
      // Card score is its best event, not the sum — otherwise five weak signals
      // would outrank one genuinely important one.
      score: scored[0]!.score,
      freshness: freshnessOf(q.asOf, now, q.source),
      asOf: q.asOf,
    });
  }

  // Persist what we surfaced. UNIQUE(dedup_key) makes this idempotent, so refreshing
  // the digest ten times records each event exactly once. Skipped entirely during
  // replay — see `builtFromReplay` above.
  if (!builtFromReplay) recordEvents(cards.flatMap((c) => c.events));

  cards.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const top = cards.slice(0, limit);
  // Cards that existed but lost the attention budget still count as "quiet" to the user.
  const overflow = cards.slice(limit).map((c) => c.symbol);

  return {
    watchlistId: opts.watchlistId,
    since: cp?.takenAt ?? null,
    sinceLabel: sinceLabel(cp?.takenAt ?? null, now),
    generatedAt: now,
    cards: top,
    quietCount: quietSymbols.length + overflow.length,
    quietSymbols: [...quietSymbols, ...overflow],
    quietDetail: quietDetail.sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0)),
    sensitivity,
    isQuiet: top.length === 0,
    marketPhase: marketPhase(now),
    unavailable,
    // Symbols whose price two providers disagreed about. Surfaced, never hidden.
    unconfirmed: items
      .map((i) => i.symbol)
      .filter((s) => unconfirmed.has(s))
      .map((s) => ({ symbol: s, reason: unconfirmed.get(s)!.reason })),
  };
}

/**
 * Human phrasing for the diff window.
 * Anchors to the last SESSION CLOSE when the market is shut, because "0.0% in 65 hours"
 * is technically true and completely useless over a weekend.
 */
export function sinceLabel(takenAt: number | null, now: number): string {
  if (takenAt === null) return 'your first visit';
  const ms = Math.max(0, now - takenAt);
  const mins = Math.round(ms / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  const closed = marketPhase(now) === 'CLOSED' && takenAt < lastSessionClose(now);
  return closed
    ? `${days} day${days === 1 ? '' : 's'} ago — nothing has traded since Friday's close`
    : `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Turn a z-score into something a person can act on.
 *
 * "1.31σ, below the 1.5 threshold" is precise and useless to a retail investor. What they
 * want to know is whether this is a normal day for this stock. The bands are wide on
 * purpose — the exact number is available for anyone who asks for it, but the default
 * reading should be a judgement, not a measurement.
 */
export function plainVerdict(z: number): string {
  const a = Math.abs(z);
  if (a < 0.5) return 'a quiet day for this stock';
  if (a < 1.0) return 'a normal-sized move for this stock';
  if (a < 1.5) return 'a bit bigger than its usual day, but not unusual';
  return 'close to unusual, just under the line';
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
function safeParse(s: string): Record<string, { price: number }> {
  try { return JSON.parse(s); } catch { return {}; }
}
export { short };
