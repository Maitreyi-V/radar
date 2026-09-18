import type { DetectedEvent } from './types.js';
import { tradingMsBetween, SESSION_MS } from '../ingestion/marketCalendar.js';

/**
 * Ranking and the attention budget.
 *
 *   score = baseScore x recencyDecay(occurredAt) x novelty(symbol, eventType)
 *
 * The digest is not "all events sorted by size" — it is a fixed budget of the user's
 * attention, spent on the few things most worth knowing. Two multipliers shape it.
 */

// Multiplying (rather than adding) the three parts is deliberate: any one of them going to
// near-zero should kill the event. Something stale, or something we've said three times
// already, shouldn't survive just because its raw size was large.

/** Half-life is ONE TRADING SESSION, measured in trading time (see below). */
// One session, not one hour or one day: "how old is this" should be counted the way the
// market counts it, so yesterday's news is worth exactly half of today's.
export const HALF_LIFE_MS = SESSION_MS;

/**
 * Recency: exponential decay halving every trading session.
 *
 * The age is measured in TRADING time, not wall-clock time — weekends, holidays and
 * overnight gaps contribute nothing. A 3-sigma move on Friday afternoon is still the most
 * recent thing that has happened when you open the app on Sunday, because nothing has
 * traded since; decaying it by 8x over a weekend would bury the only news there is.
 *
 * This matters concretely: with wall-clock decay, a genuine Friday event scored 3.19 at
 * the close and 0.46 by Monday morning — it silently vanished from the digest over a
 * weekend in which the market never opened. Same principle as the market-calendar diffing
 * in DECISIONS D9: for a market product, elapsed time means elapsed TRADING time.
 */
export function recencyDecay(occurredAt: number, now: number, halfLifeMs = HALF_LIFE_MS): number {
  // The whole trick is in this one call: tradingMsBetween skips nights, weekends and
  // holidays, so a weekend literally adds zero age to a Friday event.
  const age = tradingMsBetween(occurredAt, now);
  // 0.5 ^ (age / halfLife): one session old -> ×0.5, two sessions -> ×0.25, and so on.
  // Smooth rather than a cliff, so nothing drops out of the digest in a single tick.
  return 0.5 ** (age / halfLifeMs);
}

/** A new event type for the same stock starts with full novelty. Watchlist scope
 * is enforced when loading exposure history; each prior visit counts at most once.
 */
// 0.7 is the "I already told you this" discount. Judgement call: the third time we repeat
// the same story about the same stock it's worth roughly a third as much (0.7³ ≈ 0.34),
// which is about how fast a real person stops caring — without silencing it entirely, since
// an ongoing crash genuinely does deserve to keep showing up.
export const NOVELTY_FACTOR = 0.7;

// Keyed on stock AND event type, so a VOLUME_SPIKE in TCS doesn't suppress a later
// BREACH_52W in TCS — they're different pieces of news about the same company.
export function noveltyKey(event: Pick<DetectedEvent, 'symbol' | 'type'>): string {
  return `${event.symbol}:${event.type}`;
}

// `Pick<DetectedEvent, 'symbol' | 'type'>` is TypeScript's way of saying "an object with
// just these two fields from DetectedEvent". Asking for the narrowest thing we need means
// the tests can pass a two-field literal instead of building a whole fake event.
export function novelty(event: Pick<DetectedEvent, 'symbol' | 'type'>, recentDigestEventKeys: string[][]): number {
  const key = noveltyKey(event);
  let appearances = 0;
  // string[][] = a list of past visits, each holding the keys shown in that visit. We count
  // VISITS the user saw this in, not raw occurrences — one visit can only bore them once.
  for (const digest of recentDigestEventKeys) if (digest.includes(key)) appearances++;
  return NOVELTY_FACTOR ** appearances;   // seen 0 times -> ×1.0, once -> ×0.7, twice -> ×0.49
}

// `extends` on an interface means ScoredEvent is a DetectedEvent plus these extra fields.
// We keep recency and noveltyFactor rather than just the final score so the UI can show
// exactly WHY something ranked where it did — no unexplainable black box.
export interface ScoredEvent extends DetectedEvent {
  score: number;
  recency: number;
  noveltyFactor: number;
}

export interface ScoreOptions {
  now: number;
  // The `?` marks an optional field: callers may leave it out entirely, and its type is
  // then `number | undefined`. Each one below has a sensible default further down.
  /** Attention threshold override. Lower surfaces more. */
  threshold?: number;
  /** Stock + event-type keys displayed in this watchlist's prior visits. */
  recentDigestEventKeys?: string[][];
  halfLifeMs?: number;
}

export function scoreEvent(e: DetectedEvent, opts: ScoreOptions): ScoredEvent {
  const recency = recencyDecay(e.occurredAt, opts.now, opts.halfLifeMs);
  const nov = novelty(e, opts.recentDigestEventKeys ?? []);  // `??`: no history given -> treat as none
  // `...e` spreads every field of the original event into the new object, then we add ours.
  // The original detector output is preserved untouched, which keeps scoring auditable.
  return { ...e, recency, noveltyFactor: nov, score: e.baseScore * recency * nov };
}

/**
 * Below this, the digest says "nothing needs your attention" instead of padding itself.
 * Being willing to show an empty state is the feature — a watchlist that always
 * screams teaches users to stop listening.
 */
export const ATTENTION_THRESHOLD = 1.5;

export function rank(events: DetectedEvent[], opts: ScoreOptions): ScoredEvent[] {
  const threshold = opts.threshold ?? ATTENTION_THRESHOLD;
  return events
    .map((e) => scoreEvent(e, opts))              // attach score, recency, novelty to each
    .filter((e) => e.score >= threshold)          // drop everything not worth the interruption
    // Tie-break on symbol so equal scores produce a stable, reproducible order.
    // `||` works here because b.score - a.score is 0 on an exact tie, and 0 is falsy, so
    // it falls through to the alphabetical comparison. Without this, two equal-scoring
    // events could swap places between runs and the digest would look non-deterministic.
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}
