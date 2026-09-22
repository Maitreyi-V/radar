/**
 * Statistics for the significance engine. Pure, no I/O, no dates from Date.now().
 * Every function here must be safe on degenerate input — a stock listed yesterday has
 * no 30-day history, and a suspended stock has zero variance. Returning NaN or Infinity
 * from here would poison every score downstream, so each function states its fallback.
 */

export interface Bar { date: string; open: number | null; high: number | null; low: number | null; close: number; volume: number | null }

/** Simple daily returns r_t = (c_t - c_{t-1}) / c_{t-1}. Needs >= 2 bars. */
/**
 * Closing prices -> daily % changes.
 *
 *   [100, 102, 99, 103]  ->  [+2%, -2.94%, +4.04%]
 *
 * N prices give N-1 changes, because day 1 has no day before it to compare to.
 * Skips any day whose previous close is 0 or junk, rather than dividing by zero.
 */
export function dailyReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!.close;
    const cur = bars[i]!.close;
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(cur)) out.push((cur - prev) / prev);
  }
  return out;
}
// required for avg of stdev, avgvolume
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than 2 points. */
// how far do the daily moves usually land from their average? That's the stock's typical swing.
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2; // square them 
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
/**
 * How much this stock normally moves in a day. THE number the product rests on.
 *
 *   HDFCBANK -> 0.0091  (+/-0.91% is a normal day)
 *   PAYTM    -> 0.0281  (+/-2.81% is a normal day)
 *
 * That difference is why a 2% move matters for one and not the other.
 *
 * Takes 31 days to get 30 changes, then measures their spread.
 *
 * Returns null - never a guess - in two cases:
 *   under 6 days  : too little history. A tiny fake spread makes every move
 *                   look like a 20-sigma event.
 *   spread ~= 0   : suspended/flat stock. Dividing by it gives Infinity, which
 *                   would outrank everything else forever.
 *                   (1e-9 not 0, because float maths never gives exactly 0.)
 */

export function volatility(bars: Bar[], window = 30): number | null {
  const slice = bars.slice(-(window + 1));
  if (slice.length < 6) return null;              // too little history to be meaningful
  const s = stdev(dailyReturns(slice));
  if (!Number.isFinite(s) || s <= 1e-9) return null; // flat / suspended stock didnt move at all- so youd get a zero sigma, which is not a meaningful baseline for a z-score. Return null to stay silent.
  return s;
}

/** Trailing average volume. null when unknown. */
export function averageVolume(bars: Bar[], window = 20): number | null {
  const vols = bars.slice(-window).map((b) => b.volume).filter((v): v is number => typeof v === 'number' && v > 0); // drop null and 0
  if (vols.length < 3) return null;
  return mean(vols);
}

export function fiftyTwoWeek(bars: Bar[]): { high: number | null; low: number | null } {
  const slice = bars.slice(-252);  // 252 trading sessions in a year, ~1y of history
  let hi = -Infinity, lo = Infinity;
  for (const b of slice) {
    const h = b.high ?? b.close, l = b.low ?? b.close;   // use the high if present ; if it's null, use closing price .
    if (Number.isFinite(h)) hi = Math.max(hi, h);
    if (Number.isFinite(l)) lo = Math.min(lo, l);
  }
  return { high: Number.isFinite(hi) ? hi : null, low: Number.isFinite(lo) ? lo : null };
}

/**
 * Consecutive same-direction sessions ending at the most recent bar.
 * Positive = up streak, negative = down streak, 0 = no streak / flat last session.
 */
export function directionStreak(bars: Bar[]): number {
  const rets = dailyReturns(bars);
  if (rets.length === 0) return 0;
  const last = rets[rets.length - 1]!;
  if (last === 0) return 0; // no chnge today, so no streak.
  const sign = Math.sign(last);
  let n = 0;
 for (let i = rets.length - 1; i >= 0; i--) { // It walks backwards Streaks end at today, so you start at the newest day and go back until the direction flips.
    if (Math.sign(rets[i]!) === sign) n++;
    else break;
  }
  return sign * n; // 4 days up or 4 days down ?
}

/** Clamp to keep one absurd datapoint from dominating a ranked digest. */
// force a number into a range. If it's already in the range, return it unchanged.
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
