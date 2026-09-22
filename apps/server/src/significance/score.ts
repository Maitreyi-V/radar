import type { DetectedEvent } from './types.js';
import { tradingMsBetween, SESSION_MS } from '../ingestion/marketCalendar.js';

/**
 * Ranking and the attention budget.
 *
 *   score = baseScore x recencyDecay(lastUpdatedAt ?? occurredAt) x novelty(symbol, eventType, sessionDate)
 *
 * The digest is not "all events sorted by size" — it is a fixed budget of the user's
 * attention, spent on the few things most worth knowing. Two multipliers shape it.
 */

/** Half-life is ONE TRADING SESSION, measured in trading time (see below). */
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
  const age = tradingMsBetween(occurredAt, now);
  return 0.5 ** (age / halfLifeMs);

//   10:00 → 15:00  =  5 hours  =  18,000,000 ms
// SESSION_MS     =            22,500,000 ms

// 18,000,000 / 22,500,000 = 0.8 of a session

// decay = 0.5 ^ 0.8 = 0.574
// So an event that happened right at 10:00 keeps 57% of its score.


}

/** A new event type for the same stock starts with full novelty. Watchlist scope
 * is enforced when loading exposure history; each prior visit counts at most once.
 */
export const NOVELTY_FACTOR = 0.7;

/**
 * Novelty is a WITHIN-SESSION budget, so the key carries the session date.
 *
 * Without it, a genuinely new volume spike tomorrow inherits today's exposures and
 * opens at 0.7 — punished for something that happened on a different trading day.
 * "Have I already shown you this?" only makes sense scoped to one session.
 *
 * The date is the EVENT's own session, not the viewing date. Friday's event reopened
 * on Saturday and again on Sunday keeps one key and damps correctly, because it really
 * is the same event; using the viewing date would let it shout at full volume all weekend.
 *
 * We do not reuse `dedupKey` for this: REF_DRAWDOWN's omits the date entirely and
 * VOLATILITY_MOVE's embeds z to one decimal, so 2.4σ -> 2.5σ would reset damping mid-session.
 */
export type NoveltyIdentity = Pick<DetectedEvent, 'symbol' | 'type' | 'sessionDate'>;

export function noveltyKey(event: NoveltyIdentity): string {
  return `${event.symbol}:${event.type}:${event.sessionDate}`;
}

export function novelty(event: NoveltyIdentity, recentDigestEventKeys: string[][]): number {
  const key = noveltyKey(event);
  let appearances = 0;
  for (const digest of recentDigestEventKeys) if (digest.includes(key)) appearances++;
  return NOVELTY_FACTOR ** appearances;
}

export interface ScoredEvent extends DetectedEvent {
  score: number;
  recency: number;
  noveltyFactor: number;
}

export interface ScoreOptions {
  now: number; // current time in ms, used to compute recency decay
  /** Attention threshold override. Lower surfaces more. */
  threshold?: number;   // sensitivity 
  /** Stock + event-type keys displayed in this watchlist's prior visits. */
  recentDigestEventKeys?: string[][];
  halfLifeMs?: number; // how fast decay happens
}

// score the event cards
export function scoreEvent(e: DetectedEvent, opts: ScoreOptions): ScoredEvent {
  // Decay runs from the last time the event's STRENGTH changed, not from first detection.
  // A spike first seen at 10:00 that doubled at 14:00 is 14:00 news; anchoring to 10:00
  // would let it fade precisely as it became worth reading.
  const recency = recencyDecay(e.lastUpdatedAt ?? e.occurredAt, opts.now, opts.halfLifeMs);
  const nov = novelty(e, opts.recentDigestEventKeys ?? []);
  return { ...e, recency, noveltyFactor: nov, score: e.baseScore * recency * nov };
}

/**
 * Below this, the digest says "nothing needs your attention" instead of padding itself.
 * Being willing to show an empty state is the feature — a watchlist that always
 * screams teaches users to stop listening.
 */
export const ATTENTION_THRESHOLD = 1.5; // fallback 

export function rank(events: DetectedEvent[], opts: ScoreOptions): ScoredEvent[] {
  const threshold = opts.threshold ?? ATTENTION_THRESHOLD;
  return events
    .map((e) => scoreEvent(e, opts))
    .filter((e) => e.score >= threshold)
    // Tie-break on symbol so equal scores produce a stable, reproducible order.
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));  //    tie → alphabetical
}
