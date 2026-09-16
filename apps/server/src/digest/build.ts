import { db } from '../db/index.js';
import type { Bar } from '../significance/stats.js';
import type { DetectedEvent, SymbolContext } from '../significance/types.js';
import { detectAll, short } from '../significance/detectors.js';
import { rank, ATTENTION_THRESHOLD, type ScoredEvent } from '../significance/score.js';
import { volatility } from '../significance/stats.js';
import type { DataMode, Digest, DigestCard, Freshness } from './types.js';
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
export function freshnessOf(asOf: number, now: number, source?: string, dataMode: DataMode = 'CURRENT'): Freshness {
  if (source === 'replay') return 'REPLAY';
  if (dataMode === 'RECORDED') return 'RECORDED';
  if (marketPhase(now) !== 'OPEN') {
    // "Market closed" is only honest when this quote belongs to the most recent
    // completed session. An older quote is stale even though the market is shut now.
    if (asOf < lastSessionClose(now) - STALENESS.delayed) return 'STALE';
    return 'MARKET_CLOSED';
  }
  const age = now - asOf;
  if (age <= STALENESS.live) return 'LIVE';
  if (age <= STALENESS.delayed) return 'DELAYED';
  return 'STALE';
}

const barsStmt = db.prepare(
  `SELECT bar_date AS date, open, high, low, close, volume FROM daily_bars
   WHERE symbol = ? ORDER BY bar_date ASC`,
);
const latestNonReplayStmt = db.prepare(
  `SELECT price, volume, day_open AS dayOpen, prev_close AS prevClose,
          week52_high AS week52High, week52_low AS week52Low, as_of AS asOf, source
   FROM quotes
   WHERE symbol = ? AND source <> 'replay' AND as_of <= ?
   ORDER BY as_of DESC, id DESC LIMIT 1`,
);
const latestReplayStmt = db.prepare(
  `SELECT price, volume, day_open AS dayOpen, prev_close AS prevClose,
          week52_high AS week52High, week52_low AS week52Low, as_of AS asOf, source
   FROM quotes
   WHERE symbol = ? AND source = 'replay' AND as_of <= ?
   ORDER BY as_of DESC, id DESC LIMIT 1`,
);
const intervalNonReplayStmt = db.prepare(
  `SELECT price, volume, day_open AS dayOpen, prev_close AS prevClose,
          week52_high AS week52High, week52_low AS week52Low, as_of AS asOf, source
   FROM quotes
   WHERE symbol = ? AND source <> 'replay' AND as_of > ? AND as_of <= ?
   ORDER BY as_of ASC, id ASC`,
);
const intervalReplayStmt = db.prepare(
  `SELECT price, volume, day_open AS dayOpen, prev_close AS prevClose,
          week52_high AS week52High, week52_low AS week52Low, as_of AS asOf, source
   FROM quotes
   WHERE symbol = ? AND source = 'replay' AND as_of > ? AND as_of <= ?
   ORDER BY as_of ASC, id ASC`,
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
 * One condition can remain true across hundreds of ticks. Collapse those observations
 * into one logical event while preserving two different facts:
 *
 *   - occurredAt: the FIRST threshold crossing (what recency must use)
 *   - magnitude/detail: the strongest observation (what the explanation should report)
 *
 * A volatility move and a reference-price move are directional conditions. The other
 * detectors already produce stable per-session/per-milestone dedup keys.
 */
function logicalEventKey(event: DetectedEvent): string {
  if (event.type === 'VOLATILITY_MOVE' || event.type === 'REF_DRAWDOWN') {
    return `${event.symbol}:${event.type}:${sessionDate(event.occurredAt)}:${Math.sign(event.magnitude)}`;
  }
  return event.dedupKey;
}

function collapseIntervalEvents(events: DetectedEvent[], latestAsOf: number): DetectedEvent[] {
  const grouped = new Map<string, { firstAt: number; strongest: DetectedEvent }>();

  for (const event of events) {
    const key = logicalEventKey(event);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { firstAt: event.occurredAt, strongest: event });
      continue;
    }

    current.firstAt = Math.min(current.firstAt, event.occurredAt);
    if (event.baseScore > current.strongest.baseScore ||
        (event.baseScore === current.strongest.baseScore && Math.abs(event.magnitude) > Math.abs(current.strongest.magnitude))) {
      current.strongest = event;
    }
  }

  return [...grouped.values()].map(({ firstAt, strongest }) => {
    const peakAt = strongest.occurredAt;
    let explanation = strongest.explanation;

    // If the strongest observation is no longer the latest state, say so plainly. The
    // card's price remains the current price; this sentence describes what happened in
    // the interval rather than pretending the peak is still current.
    if (peakAt < latestAsOf && strongest.type === 'VOLATILITY_MOVE') {
      const change = Number(strongest.detail.changePct);
      const z = Number(strongest.detail.z);
      const sigma = Number(strongest.detail.sigmaPct);
      explanation =
        `${short(strongest.symbol)} ${change >= 0 ? 'rose' : 'fell'} as much as ${Math.abs(round2(change))}% ` +
        `since you left — ${Math.abs(round2(z))}× its usual daily move of about ±${round2(sigma)}%.`;
    } else if (peakAt < latestAsOf && strongest.type === 'REF_DRAWDOWN') {
      const change = Number(strongest.detail.changePct);
      const refPrice = Number(strongest.detail.refPrice);
      explanation =
        `${short(strongest.symbol)} was ${change >= 0 ? 'up' : 'down'} as much as ${Math.abs(round2(change))}% ` +
        `since you added it at ₹${round2(refPrice)}.`;
    }

    return {
      ...strongest,
      occurredAt: firstAt,
      explanation,
      detail: {
        ...strongest.detail,
        firstDetectedAt: firstAt,
        peakAt,
      },
    };
  });
}

function contextForQuote(
  symbol: string,
  quote: QuoteRow,
  bars: Bar[],
  checkpointPrice: number | undefined,
  checkpointAt: number | undefined,
  refPrice: number | undefined,
): SymbolContext {
  return {
    symbol,
    bars,
    price: quote.price,
    volume: quote.volume,
    dayOpen: quote.dayOpen,
    prevClose: quote.prevClose,
    week52High: quote.week52High,
    week52Low: quote.week52Low,
    asOf: quote.asOf,
    checkpointPrice,
    checkpointAt,
    refPrice,
    sessionDate: sessionDate(quote.asOf),
  };
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
  /** Explicit context for deterministic recorded-data demos. */
  dataMode?: DataMode;
  dataSessionDate?: string;
}): Digest {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 5;
  const sensitivity = opts.sensitivity ?? ATTENTION_THRESHOLD;
  let dataMode = opts.dataMode ?? 'CURRENT';

  const items = itemsStmt.all(opts.watchlistId) as ItemRow[];
  const cp = checkpointStmt.get(opts.watchlistId, opts.userId) as
    | { takenAt: number; snapshot: string }
    | undefined;

  const snapshot: Record<string, { price: number; acknowledgedEventKeys?: string[] }> = cp
    ? safeParse(cp.snapshot)
    : {};

  // Novelty damping needs the symbols surfaced in PRIOR digests. Bounded by this
  // checkpoint so the current window's own events cannot damp themselves — otherwise
  // viewing the digest changes it, and cards drop out on refresh.
  const history = opts.recentDigestSymbols ?? recentDigestSymbols(opts.watchlistId, cp?.takenAt);

  // A digest built from replayed ticks must NOT write into the user's real event
  // history. Replay is a simulation; letting it record events would damp novelty for
  // symbols that never actually moved, corrupting future real digests. Read-only.
  let builtFromReplay = false;

  const cards: DigestCard[] = [];
  const quietSymbols: string[] = [];
  const quietDetail: Digest['quietDetail'] = [];
  const unavailable: string[] = [];

  for (const item of items) {
    const checkpointPrice = snapshot[item.symbol]?.price;
    let q = (dataMode === 'REPLAY'
      ? latestReplayStmt.get(item.symbol, now)
      : latestNonReplayStmt.get(item.symbol, now)) as QuoteRow | undefined;

    // At the beginning of a replay, a symbol may not have emitted its first tick yet.
    // Its checkpoint price is the only state the user could honestly know at that point;
    // do not leak the tape's end-of-day quote from the future into the replay.
    if (!q && dataMode === 'REPLAY' && checkpointPrice !== undefined && cp) {
      q = {
        price: checkpointPrice, volume: null, dayOpen: null, prevClose: checkpointPrice,
        week52High: null, week52Low: null, asOf: cp.takenAt, source: 'replay',
      };
    }
    if (!q) { unavailable.push(item.symbol); continue; }   // surfaced, not silently dropped

    if (q.source === 'replay') {
      builtFromReplay = true;
      dataMode = 'REPLAY';
    }

    const bars = barsStmt.all(item.symbol) as Bar[];
    const ctx = contextForQuote(
      item.symbol, q, bars, checkpointPrice, cp?.takenAt, item.refPrice ?? undefined,
    );

    // A checkpoint is an acknowledgement boundary, not just a price baseline.
    // Suppress conditions that were already active when the user marked themselves
    // caught up. A changed event gets a changed key (4-day streak -> 5-day streak,
    // +10% reference bucket -> +20%) and can surface again.
    const acknowledged = new Set(snapshot[item.symbol]?.acknowledgedEventKeys ?? []);
    let newlyMeaningful: DetectedEvent[];

    if (cp) {
      // "Since you left" means the whole interval, not merely its final frame. Scan the
      // stored, indexed quote slice and retain the first threshold-crossing time plus
      // the strongest magnitude. A move that spikes and later reverses must not vanish.
      // Replay reads ONLY emitted replay rows, so the future of the tape cannot leak in.
      const rows = (dataMode === 'REPLAY'
        ? intervalReplayStmt.all(item.symbol, cp.takenAt, now)
        : intervalNonReplayStmt.all(item.symbol, cp.takenAt, now)) as QuoteRow[];

      const observed = rows.flatMap((row) => detectAll(contextForQuote(
        item.symbol, row, bars, checkpointPrice, cp.takenAt, item.refPrice ?? undefined,
      ))).filter((event) => !acknowledged.has(event.dedupKey));

      newlyMeaningful = collapseIntervalEvents(observed, q.asOf);
    } else {
      // A first visit has no interval anchor. Show what is meaningful in the latest
      // state, preserving the original first-visit behaviour.
      newlyMeaningful = detectAll(ctx);
    }
    const scored = rank(newlyMeaningful, { now, recentDigestSymbols: history, threshold: sensitivity });

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
      freshness: freshnessOf(q.asOf, now, q.source, dataMode),
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
    dataMode,
    dataSessionDate: opts.dataSessionDate ?? null,
    since: cp?.takenAt ?? null,
    sinceLabel: cp && dataMode === 'RECORDED'
      ? 'at the previous close in this demo scenario'
      : cp && dataMode === 'REPLAY'
        ? 'at the previous close in this replay scenario'
        : sinceLabel(cp?.takenAt ?? null, now),
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
