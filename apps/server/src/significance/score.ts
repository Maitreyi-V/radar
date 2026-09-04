import type { DetectedEvent } from './types.js';

/**
 * Ranking and the attention budget.
 *
 *   score = baseScore x recencyDecay(occurredAt) x novelty(symbol)
 *
 * The digest is not "all events sorted by size" — it is a fixed budget of the user's
 * attention, spent on the few things most worth knowing. Two multipliers shape it.
 */

export const HALF_LIFE_MS = 24 * 60 * 60 * 1000;

/**
 * Recency: exponential decay halving every 24h.
 * A 3-sigma move yesterday matters more than a 3-sigma move last Tuesday, and after a
 * long absence the digest should lead with what is still actionable, not what is oldest.
 */
export function recencyDecay(occurredAt: number, now: number, halfLifeMs = HALF_LIFE_MS): number {
  const age = Math.max(0, now - occurredAt);
  return 0.5 ** (age / halfLifeMs);
}

/**
 * Novelty: damps repeat offenders.
 * A permanently volatile small-cap would otherwise fill every digest forever and train
 * the user to ignore it. Each recent appearance multiplies its score by 0.7.
 */
export const NOVELTY_FACTOR = 0.7;

export function novelty(symbol: string, recentDigestSymbols: string[][]): number {
  let appearances = 0;
  for (const digest of recentDigestSymbols) if (digest.includes(symbol)) appearances++;
  return NOVELTY_FACTOR ** appearances;
}

export interface ScoredEvent extends DetectedEvent {
  score: number;
  recency: number;
  noveltyFactor: number;
}

export interface ScoreOptions {
  now: number;
  /** Attention threshold override. Lower surfaces more. */
  threshold?: number;
  /** Symbols surfaced in the user's last few digests, newest first. */
  recentDigestSymbols?: string[][];
  halfLifeMs?: number;
}

export function scoreEvent(e: DetectedEvent, opts: ScoreOptions): ScoredEvent {
  const recency = recencyDecay(e.occurredAt, opts.now, opts.halfLifeMs);
  const nov = novelty(e.symbol, opts.recentDigestSymbols ?? []);
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
    .map((e) => scoreEvent(e, opts))
    .filter((e) => e.score >= threshold)
    // Tie-break on symbol so equal scores produce a stable, reproducible order.
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}
