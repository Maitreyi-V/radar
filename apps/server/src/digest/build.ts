import { db } from '../db/index.js';
import type { Bar } from '../significance/stats.js';
import type { SymbolContext } from '../significance/types.js';
import { detectRefDrawdown, detectVolatilityMove, short } from '../significance/detectors.js';
import { rank, scoreEvent, ATTENTION_THRESHOLD } from '../significance/score.js';
import { volatility } from '../significance/stats.js';
import type { DataMode, Digest, DigestCard, Freshness } from './types.js';
import type { DetectedEvent } from '../significance/types.js';
import type { ScoredEvent } from '../significance/score.js';
import { marketPhase, sessionDate, lastSessionClose } from '../ingestion/marketCalendar.js';
import { STALENESS } from '../config.js';
import { recordEvents, recordDigestExposure, recentDigestEventKeys } from './events.js';
import { unconfirmed } from '../ingestion/conflict.js';
import { barsBefore, marketEvents } from '../ingestion/projections.js';
import { personalEvents } from './personal.js';

/**
 * Honest data-age label. We never render a price without saying how old it is —
 * and never present replayed data as live market data.
 *
 * REPLAY outranks every other state on purpose: a replayed tick genuinely IS fresh
 * (we produced it a moment ago), so the age check alone would happily call it LIVE.
 * That would be technically true and materially misleading, which is exactly the kind
 * of quiet lie this product exists to refuse.
 */
// The order of these checks IS the policy — each return is a claim we're willing to defend.
export function freshnessOf(asOf: number, now: number, source?: string, dataMode: DataMode = 'CURRENT'): Freshness {
  if (source === 'replay') return 'REPLAY';      // checked first: provenance beats age
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
  return 'STALE';                                // we'd rather say "old" than imply it's current
}

// `as_of <= ?` on both of these is what makes a replay honest: we ask for the latest quote
// AS OF a given moment, so a demo can never see ticks from later in the tape.
const latestNonReplayStmt = db.prepare(
  `SELECT price, volume, day_open AS dayOpen, prev_close AS prevClose,
          week52_high AS week52High, week52_low AS week52Low, as_of AS asOf, market_as_of AS marketAsOf, source
   FROM quotes
   WHERE symbol = ? AND source <> 'replay' AND as_of <= ?
   ORDER BY as_of DESC, id DESC LIMIT 1`,
);
const latestReplayStmt = db.prepare(
  `SELECT price, volume, day_open AS dayOpen, prev_close AS prevClose,
          week52_high AS week52High, week52_low AS week52Low, as_of AS asOf, market_as_of AS marketAsOf, source
   FROM quotes
   WHERE symbol = ? AND source = 'replay' AND as_of <= ?
   ORDER BY as_of DESC, id DESC LIMIT 1`,
);
const itemsStmt = db.prepare(
  // LEFT JOIN + COALESCE: show the company name when we know it, otherwise fall back to the
  // ticker. A stock we haven't imported a name for still appears — it just appears plainer.
  `SELECT wi.symbol, wi.ref_price AS refPrice, wi.added_at AS addedAt,
          COALESCE(s.name, wi.symbol) AS name
   FROM watchlist_items wi LEFT JOIN symbols s ON s.symbol = wi.symbol
   WHERE wi.watchlist_id = ? ORDER BY wi.added_at ASC`,
);
// The checkpoint is the heart of "since you left": when the user last marked themselves
// caught up, and what prices they saw at that moment.
const checkpointStmt = db.prepare(
  `SELECT id, taken_at AS takenAt, snapshot FROM checkpoints
   WHERE watchlist_id = ? AND user_id = ? ORDER BY taken_at DESC LIMIT 1`,
);

interface ItemRow { symbol: string; refPrice: number | null; addedAt: number; name: string }
interface QuoteRow {
  price: number; volume: number | null; dayOpen: number | null; prevClose: number | null;
  week52High: number | null; week52Low: number | null; asOf: number; marketAsOf?: number; source: string;
}

// Plain assembly, no logic: turns a database row plus the user's personal state into the
// context object detectors accept. Kept separate so the detectors stay unaware of SQL.
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
    sessionDate: sessionDate(quote.marketAsOf ?? quote.asOf),   // replay: the tape's session, not today's
  };
}

/**
 * Build the "since you left" digest.
 *
 * Computed at READ time, on demand, never precomputed per user. Users are absent most
 * of the time, and computing digests for absent users is work nobody will ever read.
 * Shared events and summaries are maintained during ingestion; personalisation stays here — so a crash
 * mid-digest corrupts nothing; we simply recompute.
 */
export function buildDigest(opts: {
  userId: string;
  watchlistId: string;
  // Every one of these is optional with a default below. `now` in particular is injected
  // rather than read from the clock inside, which is what makes the tests deterministic.
  now?: number;
  limit?: number;
  recentDigestEventKeys?: string[][];
  /** Attention threshold. Lower = more surfaces. Defaults to ATTENTION_THRESHOLD. */
  sensitivity?: number;
  /** Explicit context for deterministic recorded-data demos. */
  dataMode?: DataMode;
  dataSessionDate?: string;
}): Digest {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 5;                 // the attention budget: five cards, not fifty
  const sensitivity = opts.sensitivity ?? ATTENTION_THRESHOLD;
  // `let`, not const: if any quote turns out to be replayed, we upgrade the mode below so
  // the whole digest is labelled consistently rather than half-live and half-replay.
  let dataMode = opts.dataMode ?? 'CURRENT';

  const items = itemsStmt.all(opts.watchlistId) as ItemRow[];
  const cp = checkpointStmt.get(opts.watchlistId, opts.userId) as
    | { id: string; takenAt: number; snapshot: string }
    | undefined;                                 // undefined = this user's first ever visit

  // `safeParse` (bottom of file) rather than JSON.parse: a corrupt snapshot degrades to "no
  // checkpoint", which just means the user sees more. A throw here would break the app.
  const snapshot: Record<string, { price: number; acknowledgedEventKeys?: string[] }> = cp
    ? safeParse(cp.snapshot)
    : {};

  // Novelty damping needs stock + event-type pairs displayed in PRIOR digests. Bounded by this
  // checkpoint so the current window's own events cannot damp themselves — otherwise
  // viewing the digest changes it, and cards drop out on refresh.
  const history = opts.recentDigestEventKeys ?? recentDigestEventKeys(opts.watchlistId, cp?.takenAt);

  // A digest built from replayed ticks must NOT write into the user's real event
  // history. Replay is a simulation; letting it record events would damp novelty for
  // symbols that never actually moved, corrupting future real digests. Read-only.
  let builtFromReplay = false;

  const cards: DigestCard[] = [];                // stocks with something worth saying
  const quietSymbols: string[] = [];             // stocks we looked at and deliberately stayed silent on
  const quietDetail: Digest['quietDetail'] = []; // the arithmetic behind each silence
  const unavailable: string[] = [];              // stocks we genuinely have no data for
  // The price arithmetic for EVERY symbol we priced, keyed by symbol. Cards that lose the
  // attention budget below become quiet rows too, and they need the same numbers a
  // never-carded symbol gets — otherwise the quiet table would show blanks for them.
  const stats = new Map<string, QuietStats>();

  for (const item of items) {
    // `?.` optional chaining: if there's no snapshot entry for this stock, the whole
    // expression is undefined instead of throwing on a missing key.
    const checkpointPrice = snapshot[item.symbol]?.price;
    let q = (dataMode === 'REPLAY'
      ? latestReplayStmt.get(item.symbol, now)
      : latestNonReplayStmt.get(item.symbol, now)) as QuoteRow | undefined;

    // At the beginning of a replay, a symbol may not have emitted its first tick yet.
    // Its checkpoint price is the only state the user could honestly know at that point;
    // do not leak the tape's end-of-day quote from the future into the replay.
    if (!q && dataMode === 'REPLAY' && checkpointPrice !== undefined && cp) {
      // Synthesised from what the user already saw, so it can produce no new event —
      // price equals prevClose equals the checkpoint, which every detector reads as "flat".
      q = {
        price: checkpointPrice, volume: null, dayOpen: null, prevClose: checkpointPrice,
        week52High: null, week52Low: null, asOf: cp.takenAt, source: 'replay',
      };
    }
    if (!q) { unavailable.push(item.symbol); continue; }   // surfaced, not silently dropped
    // EDGE CASE above: a stock we've never successfully fetched. The user is told we have
    // no data for it, which is very different from us telling them it was quiet.

    if (q.source === 'replay') {
      builtFromReplay = true;                    // latches the write-suppression below
      dataMode = 'REPLAY';                       // and forces the honest label on every card
    }

    const bars = barsBefore(item.symbol, sessionDate(q.marketAsOf ?? q.asOf));
    const ctx = contextForQuote(
      item.symbol, q, bars, checkpointPrice, cp?.takenAt, item.refPrice ?? undefined,
    );   // `?? undefined` converts SQL's null into the "field absent" the type expects

    // A checkpoint is an acknowledgement boundary, not just a price baseline.
    // Suppress conditions that were already active when the user marked themselves
    // caught up. A changed event gets a changed key (4-day streak -> 5-day streak,
    // +10% reference bucket -> +20%) and can surface again.
    const acknowledged = new Set(snapshot[item.symbol]?.acknowledgedEventKeys ?? []);
    const stream = dataMode === 'REPLAY' ? 'replay' : 'market';
    // First visits use the latest session's market events and latest personal state.
    // Checkpoint visits preserve the full absence without rerunning shared detectors.
    // `Math.max(cp.takenAt, item.addedAt)` is the subtle bit: a stock added AFTER the last
    // checkpoint must only report what happened since it was added, not before.
    const after = cp ? Math.max(cp.takenAt, item.addedAt) : (q.asOf - 24 * 3600_000);
    // The market-wide half was already computed once at ingestion — here we only read it
    // back and drop anything this user has already dismissed.
    const shared = marketEvents(item.symbol, stream, after, now)
      .filter((event) => !acknowledged.has(event.dedupKey));
    // The personal half. With a checkpoint we reconstruct the whole absence (see
    // personal.ts); on a first visit there's no absence to reconstruct, so we just run the
    // two personal detectors against the current quote.
    const personal = cp
      ? personalEvents({ symbol: item.symbol, stream, after, until: now, latestAsOf: q.asOf,
          checkpointPrice, refPrice: item.refPrice ?? undefined, acknowledged, sensitivity })
      : [detectVolatilityMove(ctx), detectRefDrawdown(ctx)].filter((event) => event !== null);
    const newlyMeaningful = [...shared, ...personal];
    // rank() applies recency + novelty and drops anything under the threshold. This is the
    // single place where "is it worth interrupting the user" gets decided.
    const scored = rank(newlyMeaningful, { now, recentDigestEventKeys: history, threshold: sensitivity });

    // Record the arithmetic behind the silence, so the user can audit it.
    // This is the product's credibility: "nothing happened" is a claim, and a user
    // who can't check it will assume we're broken. So we show our working for silence too.
    // Computed for every priced symbol, not just the quiet ones, because a card can still
    // fall out of the attention budget below and land in the quiet table.
    const sigma = volatility(bars, 30);
    const base = checkpointPrice ?? q.prevClose;
    // Each of these can be null, and null propagates rather than becoming a fake 0 —
    // "we couldn't compute this" must stay distinguishable from "this came out zero".
    const change = base && base > 0 ? ((q.price - base) / base) : null;
    const z = sigma !== null && change !== null ? change / sigma : null;
    const row: QuietStats = {
      symbol: item.symbol, name: item.name, price: q.price,
      changePct: change === null ? null : round2(change * 100),
      sigmaPct: sigma === null ? null : round2(sigma * 100),
      z: z === null ? null : round2(z),
    };
    stats.set(item.symbol, row);

    if (scored.length === 0) {
      quietSymbols.push(item.symbol);
      // The price verdict below describes the PRICE. If this stock's only signal was a
      // non-price one — 3x normal volume on a flat tape, a 52-week breach, a gap — then
      // "a quiet day for this stock" is a true sentence about the wrong thing. So rescore
      // the same events WITHOUT the threshold filter and name the biggest one we held back.
      const suppressed = bestSuppressed(newlyMeaningful, now, history);
      quietDetail.push({
        ...row,
        // Plain-English verdict. The z-score stays in the payload for anyone who wants
        // it, but the sentence a user reads must not require a statistics background.
        // Ordered from least to most informative: a signal we deliberately held back,
        // then no history at all, then no baseline price, then an actual judgement.
        reason: suppressed
          ? `${suppressed.explanation} — below your attention threshold`
          : sigma === null
            ? "we don't have enough history for this stock yet"
            : z === null
              ? 'no earlier price to compare against'
              : plainVerdict(z),
        ...(suppressed ? { suppressed: describe(suppressed) } : {}),
      });
      continue;
    }

    cards.push({
      symbol: item.symbol,
      name: item.name,
      price: q.price,
      changePct: row.changePct,
      events: scored,
      headline: scored[0]!.explanation,          // rank() sorted these, so [0] is the best one
      supporting: scored.slice(1).map((e) => e.explanation),   // the rest, as corroboration
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

  // Same tie-break rule as inside rank(): score first, then symbol, so two runs over
  // identical data always produce identical output — which is what makes a demo repeatable.
  cards.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const top = cards.slice(0, limit);
  // Only the cards we actually SHOWED get recorded as seen. Something that lost the budget
  // was never read, so damping its novelty would silence news the user never received.
  if (!builtFromReplay && dataMode !== 'REPLAY') {
    recordEvents(top.flatMap((c) => c.events));
    recordDigestExposure(opts.watchlistId, cp?.id ?? 'first-visit', now, top.flatMap((c) => c.events));
  }
  // Cards that existed but lost the attention budget still count as "quiet" to the user.
  const overflowCards = cards.slice(limit);
  const overflow = overflowCards.map((c) => c.symbol);
  // ...and they get an explanation too. "Nothing unusual in 3 other stocks" with no row to
  // click into is the same silent lie as the price-verdict bug above: these stocks DID
  // clear the threshold, they just lost a ranking. Say which signal lost, and to what.
  for (const c of overflowCards) {
    const best = c.events[0]!;                   // a card exists only if it has events
    quietDetail.push({
      ...(stats.get(c.symbol) ?? {
        symbol: c.symbol, name: c.name, price: c.price,
        changePct: c.changePct, sigmaPct: null, z: null,
      }),
      reason: `${best.explanation} — ranked below the top ${limit}`,
      suppressed: describe(best),
    });
  }

  return {
    watchlistId: opts.watchlistId,
    dataMode,
    dataSessionDate: opts.dataSessionDate ?? null,
    since: cp?.takenAt ?? null,
    // Demo and replay modes get their own wording, because "3 hours ago" would be a lie
    // about data that's standing in for a different point in time entirely.
    sinceLabel: cp && dataMode === 'RECORDED'
      ? 'at the previous close in this demo scenario'
      : cp && dataMode === 'REPLAY'
        ? 'at the previous close in this replay scenario'
        : sinceLabel(cp?.takenAt ?? null, now),
    generatedAt: now,
    cards: top,
    // Quiet = we checked and chose silence. Counting overflow here keeps the arithmetic
    // honest: every stock on the watchlist is accounted for as card, quiet, or unavailable.
    quietCount: quietSymbols.length + overflow.length,
    quietSymbols: [...quietSymbols, ...overflow],
    // Biggest near-misses first, so "why didn't this show up?" is answered at the top.
    quietDetail: quietDetail.sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0)),
    sensitivity,
    isQuiet: top.length === 0,                   // the empty state is a real, designed outcome
    marketPhase: marketPhase(now),
    unavailable,
    // Symbols whose price two providers disagreed about. Surfaced, never hidden.
    // `!` after .get(s) is safe because .filter(has) just proved the entry exists.
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
  if (takenAt === null) return 'your first visit';   // EDGE CASE: no checkpoint to measure from
  const ms = Math.max(0, now - takenAt);         // Math.max guards a clock that stepped backwards
  const mins = Math.round(ms / 60000);
  // Coarsening as the gap grows: nobody needs "127 minutes", they need "2 hours".
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  const closed = marketPhase(now) === 'CLOSED' && takenAt < lastSessionClose(now);
  // The weekend case: telling someone "2 days ago" invites them to wonder what they missed.
  // Saying nothing has traded since Friday answers the real question instead.
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
  const a = Math.abs(z);                         // direction is already on the card; size is the question
  if (a < 0.5) return 'a quiet day for this stock';
  if (a < 1.0) return 'a normal-sized move for this stock';
  if (a < 1.5) return 'a bit bigger than its usual day, but not unusual';
  // Anything reaching here is under the 1.5 cutoff by definition — saying "just under the
  // line" tells the user the system saw it and made a call, rather than missing it.
  return 'close to unusual, just under the line';
}

/** The audit numbers every quiet row carries, whatever the reason for the silence. */
// Derived from the payload type rather than restated, so adding a field to quietDetail
// can never leave this out of step with it.
type QuietStats = Omit<Digest['quietDetail'][number], 'reason' | 'suppressed'>;

/**
 * The best event we chose NOT to show.
 *
 * rank() drops everything under the threshold, which is precisely what we need it not to
 * do here — we want the best of the events it would have dropped. Same scoring, same
 * tie-break, no filter, so the signal named in the quiet row is the one that came closest.
 */
function bestSuppressed(events: DetectedEvent[], now: number, history: string[][]): ScoredEvent | undefined {
  return events
    .map((e) => scoreEvent(e, { now, recentDigestEventKeys: history }))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))[0];
}

// Trims a held-back event to what the quiet table renders. We reuse the detector's own
// explanation rather than writing new copy for the quiet case: one sentence per signal,
// written once, so the wording can't drift between the card and the row that explains
// why there is no card.
function describe(e: ScoredEvent): NonNullable<Digest['quietDetail'][number]['suppressed']> {
  return { type: e.type, explanation: e.explanation, score: round2(e.score) };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
// A snapshot we can't read means the user sees MORE than they should, never less. Failing
// open is the right direction here: the cost is a repeated card, not a missed event.
function safeParse(s: string): Record<string, { price: number }> {
  try { return JSON.parse(s); } catch { return {}; }
}
// Re-exported so callers get the display helper from the digest module they already import.
export { short };
