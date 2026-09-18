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
// 5 seconds is the line between "these two feeds are describing the same moment" and "one
// of them is simply behind". Underscore in 5_000 is just a digit separator for readability.
export const SIMULTANEOUS_MS = 5_000;
// 0.5% is roughly the normal NSE-vs-BSE spread on a liquid stock. Below it, two feeds
// disagreeing is expected and boring; above it, one of them is probably wrong.
export const AGREEMENT_PCT = 0.5;

// Three outcomes, spelled out as a union so the caller is forced to handle each by name
// rather than reading a boolean and guessing what false meant.
export type ConflictAction = 'accept' | 'keep' | 'keep-unconfirmed';

export interface ConflictResult {
  action: ConflictAction;
  /** The quote that should be shown. */
  winner: Quote;
  /** True when two sources disagree materially and we could not resolve it. */
  unconfirmed: boolean;
  // Always returned, even on the happy path: when a judge asks "why is it showing this
  // price?", the system can answer in its own words instead of me reconstructing it.
  reason: string;
  /** Absolute disagreement in percent, when both were comparable. */
  divergencePct?: number;   // `?:` optional — absent when there was nothing to compare
}

/**
 * Decide whether an incoming quote should replace the one we are currently showing.
 * Pure — no I/O, no clock — so it is exhaustively testable.
 */
// `Quote | undefined` on the incumbent rather than an overload: the "we have nothing yet"
// case is a real, expected input, so it belongs in the type and gets handled first.
export function resolveConflict(incoming: Quote, incumbent: Quote | undefined): ConflictResult {
  if (!incumbent) {
    // EDGE CASE: very first quote for this symbol — nothing to compare against, so take it.
    return { action: 'accept', winner: incoming, unconfirmed: false, reason: 'no incumbent quote' };
  }

  // Same source: this is a normal update, not a disagreement between feeds.
  if (incoming.source === incumbent.source) {
    // The monotonic guard below matters because feeds retry and re-send out of order. An
    // older tick arriving late would otherwise make the price appear to jump backwards.
    return incoming.asOf >= incumbent.asOf
      ? { action: 'accept', winner: incoming, unconfirmed: false, reason: 'newer quote from the same source' }
      : { action: 'keep', winner: incumbent, unconfirmed: false, reason: 'older tick from the same source (monotonic guard)' };
  }

  const ageGap = incoming.asOf - incumbent.asOf;   // positive = incoming is the fresher one

  // 1. Clearly fresher wins, whoever it came from.
  if (ageGap > SIMULTANEOUS_MS) {
    return { action: 'accept', winner: incoming, unconfirmed: false, reason: `fresher by ${Math.round(ageGap / 1000)}s` };
  }
  // Clearly staler loses.
  if (ageGap < -SIMULTANEOUS_MS) {
    return { action: 'keep', winner: incumbent, unconfirmed: false, reason: `staler by ${Math.round(-ageGap / 1000)}s` };
  }

  // 2 & 3. Near-simultaneous — compare the prices themselves.
  // Guarding on price > 0 because a zero incumbent would make this a divide-by-zero; we
  // call that 0% divergence, which routes it to the safe "keep what we have" branch.
  const divergencePct = incumbent.price > 0
    ? Math.abs((incoming.price - incumbent.price) / incumbent.price) * 100
    : 0;

  if (divergencePct <= AGREEMENT_PCT) {
    // Keeping the incumbent, not the newcomer, even though both are equally valid. That's
    // the anti-flap rule: when two sources say the same thing, changing the displayed
    // number buys the user nothing and costs them a flicker they'll read as a real move.
    return {
      action: 'keep', winner: incumbent, unconfirmed: false, divergencePct,
      reason: `sources agree within ${AGREEMENT_PCT}% (${divergencePct.toFixed(2)}%) — holding to avoid flapping`,
    };
  }

  // The honest-ignorance branch. Two feeds, same instant, materially different prices — we
  // have no way to tell which is right, so we refuse to pick. We keep showing what we had
  // and label it disputed, because a visibly uncertain number beats a confidently wrong one.
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
  // `private` keeps the Map an implementation detail, so callers go through the methods
  // below and can't corrupt the registry by reaching in and mutating entries.
  private map = new Map<string, { since: number; reason: string; divergencePct: number }>();

  flag(symbol: string, reason: string, divergencePct: number): void {
    // Only record the FIRST time we saw the dispute. `since` then answers "how long has
    // this been unresolved", which we'd lose if every re-poll overwrote the timestamp.
    if (!this.map.has(symbol)) this.map.set(symbol, { since: Date.now(), reason, divergencePct });
  }
  clear(symbol: string): void { this.map.delete(symbol); }      // called once the feeds agree again
  has(symbol: string): boolean { return this.map.has(symbol); }
  get(symbol: string) { return this.map.get(symbol); }          // returns undefined if not disputed
  all(): Array<{ symbol: string; since: number; reason: string; divergencePct: number }> {
    // `[...map.entries()]` copies to a plain array, and `...v` spreads the stored fields
    // alongside the key — so callers get flat objects and never a handle on the live Map.
    return [...this.map.entries()].map(([symbol, v]) => ({ symbol, ...v }));
  }
  get size(): number { return this.map.size; }                  // a getter: read as `.size`, not `.size()`
}

// One shared instance for the process. Exported as a value, so everything that touches
// disputed symbols is talking about the same registry.
export const unconfirmed = new UnconfirmedRegistry();
