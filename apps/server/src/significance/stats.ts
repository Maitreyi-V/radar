/**
 * Statistics for the significance engine. Pure, no I/O, no dates from Date.now().
 * Every function here must be safe on degenerate input — a stock listed yesterday has
 * no 30-day history, and a suspended stock has zero variance. Returning NaN or Infinity
 * from here would poison every score downstream, so each function states its fallback.
 */

// One day of price history for one stock. Note `number | null` on most fields: that's a
// TypeScript union type, meaning "either a number or literally null" — the compiler then
// forces us to handle the null case before doing maths. Only `close` is non-null, because
// a bar with no closing price is useless to us and never gets stored in the first place.
export interface Bar { date: string; open: number | null; high: number | null; low: number | null; close: number; volume: number | null }

/** Simple daily returns r_t = (c_t - c_{t-1}) / c_{t-1}. Needs >= 2 bars. */
export function dailyReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {          // start at 1: a return needs a yesterday
    // The `!` is a non-null assertion — it tells TypeScript "trust me, this isn't
    // undefined". Safe here because the loop bounds guarantee both indexes exist.
    const prev = bars[i - 1]!.close;
    const cur = bars[i]!.close;
    // Guard against a zero or junk price: dividing by zero would put Infinity into the
    // returns array, and one Infinity makes the whole volatility number meaningless.
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(cur)) out.push((cur - prev) / prev);
  }
  return out;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;                   // EDGE CASE: empty input -> 0, not NaN from 0/0
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than 2 points. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;                     // EDGE CASE: one point has no spread; n-1 would be 0
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;          // sum of squared distances from the average
  // Dividing by n-1 rather than n is the "sample" standard deviation. We only ever see a
  // sample of a stock's life, not every day it will ever trade, and n-1 corrects for the
  // fact that a small sample always looks slightly calmer than the stock really is.
  return Math.sqrt(ss / (xs.length - 1));
}

/**
 * The stock's own daily-return sigma over the trailing `window` sessions.
 *
 * This single number is the product thesis in code: it is what converts "moved 2%"
 * into "moved 2.8 sigma FOR THIS STOCK". Returns null when we cannot honestly compute
 * it — too little history, or a flat/suspended stock with zero variance. Callers must
 * degrade gracefully rather than divide by zero.
 */
export function volatility(bars: Bar[], window = 30): number | null {
  // window + 1 bars, because turning N+1 closing prices into returns gives us N returns.
  const slice = bars.slice(-(window + 1));
  if (slice.length < 6) return null;              // too little history to be meaningful
  // EDGE CASE above: newly listed stock -> we say null ("I don't know") instead of
  // computing a confident-looking sigma from four days of data and ranking it highly.
  const s = stdev(dailyReturns(slice));
  if (!Number.isFinite(s) || s <= 1e-9) return null; // flat / suspended
  // EDGE CASE above: a suspended stock prints the same close every day, so sigma is ~0.
  // Any move divided by ~0 is a near-infinite score, which would rocket a dead stock to
  // the top of the digest. Saying null keeps us quiet instead of confidently wrong.
  return s;
}

/** Trailing average volume. null when unknown. */
export function averageVolume(bars: Bar[], window = 20): number | null {
  // `(v): v is number` is a type predicate — it tells TypeScript that anything surviving
  // this filter is definitely a number, so the resulting array is number[] and not
  // (number | null)[]. Without it the compiler would still think nulls could be in there.
  const vols = bars.slice(-window).map((b) => b.volume).filter((v): v is number => typeof v === 'number' && v > 0);
  if (vols.length < 3) return null;               // EDGE CASE: illiquid or new stock -> no baseline
  return mean(vols);
}

export function fiftyTwoWeek(bars: Bar[]): { high: number | null; low: number | null } {
  const slice = bars.slice(-252);                 // ~252 trading sessions is one calendar year
  let hi = -Infinity, lo = Infinity;              // start at the extremes so any real bar wins
  for (const b of slice) {
    // `??` is the nullish-coalescing operator: "use the left side unless it's null or
    // undefined, then use the right". Some feeds give us a close but no high/low, so we
    // fall back to the close — a day we half-know is better than a day we throw away.
    const h = b.high ?? b.close, l = b.low ?? b.close;
    if (Number.isFinite(h)) hi = Math.max(hi, h);
    if (Number.isFinite(l)) lo = Math.min(lo, l);
  }
  // If no bar was usable, hi/lo are still +/-Infinity — report null rather than leak
  // Infinity into "distance from 52-week high" arithmetic downstream.
  return { high: Number.isFinite(hi) ? hi : null, low: Number.isFinite(lo) ? lo : null };
}

/**
 * Consecutive same-direction sessions ending at the most recent bar.
 * Positive = up streak, negative = down streak, 0 = no streak / flat last session.
 */
export function directionStreak(bars: Bar[]): number {
  const rets = dailyReturns(bars);
  if (rets.length === 0) return 0;                // EDGE CASE: fewer than 2 bars -> no streak to speak of
  const last = rets[rets.length - 1]!;
  if (last === 0) return 0;                       // EDGE CASE: flat close -> a streak has no direction
  const sign = Math.sign(last);                   // +1 for an up day, -1 for a down day
  let n = 0;
  // Walk backwards from today and stop the moment the direction flips. We deliberately
  // count from the most recent bar because a streak that ended last week isn't news today.
  for (let i = rets.length - 1; i >= 0; i--) {
    if (Math.sign(rets[i]!) === sign) n++;
    else break;
  }
  // Packing direction and length into one signed number: -4 reads as "four down days".
  return sign * n;
}

/** Clamp to keep one absurd datapoint from dominating a ranked digest. */
// Judgement, not mechanics: a bad tick or a 1-for-10 split can show up as a 40-sigma move.
// Without a ceiling that single row would own the whole digest and push out four genuinely
// interesting stocks, so we cap the contribution rather than trust the outlier.
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
