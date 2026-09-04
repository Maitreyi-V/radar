import type { Quote } from './types.js';

/**
 * Conflicting-data policy.
 *
 * BSE and NSE are different exchanges, so the same company genuinely carries two slightly
 * different prices at the same instant. Free feeds also disagree because of lag, bad ticks
 * and mid-cancellation. A watchlist that simply takes whichever quote arrived last will
 * FLAP: the price flips back and forth between sources and the user cannot tell whether
 * anything really moved.
 *
 * The rule, in order:
 *   1. If one quote is meaningfully fresher (>5s), trust it. Recency wins outright.
 *   2. If they are near-simultaneous (<=5s apart) and agree within 0.5%, keep the
 *      incumbent — the difference is exchange spread, not news. Switching would flap.
 *   3. If they are near-simultaneous and disagree by MORE than 0.5%, we genuinely do not
 *      know which is right. Hold the incumbent value, mark the symbol `unconfirmed`, and
 *      re-poll. Never adopt a disputed price, and never hide the dispute.
 *
 * Deliberately conservative: the cost of showing a slightly stale price is far lower than
 * the cost of showing a wrong one, or of a number that jitters between two feeds.
 */
export const SIMULTANEOUS_MS = 5_000;
export const AGREEMENT_PCT = 0.5;

export type ConflictAction = 'accept' | 'keep' | 'keep-unconfirmed';

export interface ConflictResult {
  action: ConflictAction;
  /** The quote that should be shown. */
  winner: Quote;
  /** True when two sources disagree materially and we could not resolve it. */
  unconfirmed: boolean;
  reason: string;
  /** Absolute disagreement in percent, when both were comparable. */
  divergencePct?: number;
}

/**
 * Decide whether an incoming quote should replace the one we are currently showing.
 * Pure — no I/O, no clock — so it is exhaustively testable.
 */
export function resolveConflict(incoming: Quote, incumbent: Quote | undefined): ConflictResult {
  if (!incumbent) {
    return { action: 'accept', winner: incoming, unconfirmed: false, reason: 'no incumbent quote' };
  }

  // Same source: this is a normal update, not a disagreement between feeds.
  if (incoming.source === incumbent.source) {
    return incoming.asOf >= incumbent.asOf
      ? { action: 'accept', winner: incoming, unconfirmed: false, reason: 'newer quote from the same source' }
      : { action: 'keep', winner: incumbent, unconfirmed: false, reason: 'older tick from the same source (monotonic guard)' };
  }

  const ageGap = incoming.asOf - incumbent.asOf;

  // 1. Clearly fresher wins, whoever it came from.
  if (ageGap > SIMULTANEOUS_MS) {
    return { action: 'accept', winner: incoming, unconfirmed: false, reason: `fresher by ${Math.round(ageGap / 1000)}s` };
  }
  // Clearly staler loses.
  if (ageGap < -SIMULTANEOUS_MS) {
    return { action: 'keep', winner: incumbent, unconfirmed: false, reason: `staler by ${Math.round(-ageGap / 1000)}s` };
  }

  // 2 & 3. Near-simultaneous — compare the prices themselves.
  const divergencePct = incumbent.price > 0
    ? Math.abs((incoming.price - incumbent.price) / incumbent.price) * 100
    : 0;

  if (divergencePct <= AGREEMENT_PCT) {
    return {
      action: 'keep', winner: incumbent, unconfirmed: false, divergencePct,
      reason: `sources agree within ${AGREEMENT_PCT}% (${divergencePct.toFixed(2)}%) — holding to avoid flapping`,
    };
  }

  return {
    action: 'keep-unconfirmed', winner: incumbent, unconfirmed: true, divergencePct,
    reason: `${incoming.source} and ${incumbent.source} disagree by ${divergencePct.toFixed(2)}% ` +
            `within ${SIMULTANEOUS_MS / 1000}s — holding current value and re-polling`,
  };
}

/**
 * Symbols currently flagged as disputed, with why. In-process on purpose: this is
 * transient state about the live feed, not a fact worth persisting.
 */
class UnconfirmedRegistry {
  private map = new Map<string, { since: number; reason: string; divergencePct: number }>();

  flag(symbol: string, reason: string, divergencePct: number): void {
    if (!this.map.has(symbol)) this.map.set(symbol, { since: Date.now(), reason, divergencePct });
  }
  clear(symbol: string): void { this.map.delete(symbol); }
  has(symbol: string): boolean { return this.map.has(symbol); }
  get(symbol: string) { return this.map.get(symbol); }
  all(): Array<{ symbol: string; since: number; reason: string; divergencePct: number }> {
    return [...this.map.entries()].map(([symbol, v]) => ({ symbol, ...v }));
  }
  get size(): number { return this.map.size; }
}

export const unconfirmed = new UnconfirmedRegistry();
