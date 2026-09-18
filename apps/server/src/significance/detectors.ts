// `import type` imports ONLY the shapes, not runtime code — TypeScript erases this line
// entirely when it compiles, so it can never cause a circular-import problem at runtime.
import type { SymbolContext, DetectedEvent } from './types.js';
import { volatility, averageVolume, fiftyTwoWeek, directionStreak, clamp } from './stats.js';

/**
 * Detectors: pure (SymbolContext) -> DetectedEvent | null.
 *
 * Every detector must return null rather than throw when the data cannot support a
 * confident answer. A missing signal is honest; a fabricated one destroys trust.
 * Thresholds live here as named constants so they are reviewable in one place.
 */

// Every number that decides "is this worth telling the user" lives in this one object.
// Judgement: if a panellist asks "why 1.5 sigma and not 2?", I want to change one line and
// show the effect, not hunt for magic numbers scattered across six functions.
// `as const` freezes this — the fields become readonly and each value is typed as its exact
// literal (1.5, not just "some number"), so nothing downstream can quietly reassign them.
export const THRESHOLDS = {
  volatilityZ: 1.5,        // sigma
  volumeRatio: 2.5,        // x 20-day average
  gapZ: 1.5,               // sigma
  streakDays: 4,           // consecutive sessions
  refDrawdownPct: 10,      // % from the user's entry reference
} as const;

const pct = (a: number, b: number): number => ((a - b) / b) * 100;  // % change from b to a
const r1 = (n: number): number => Math.round(n * 10) / 10;          // round to 1 decimal, for prose
const r2 = (n: number): number => Math.round(n * 100) / 100;        // round to 2 decimals, for data
const dir = (n: number): string => (n >= 0 ? 'rose' : 'fell');      // sign -> a word a human reads

/**
 * VOLATILITY_MOVE — the flagship detector.
 *
 * Converts a raw % move into a z-score against the stock's OWN 30-day daily-return
 * sigma. This is the whole product thesis: a 2% day in a large-cap bank is a genuine
 * event; a 2% day in a volatile small-cap is background noise. A fixed % threshold
 * cannot tell them apart; a z-score can.
 *
 * Baseline is the checkpoint price when we have one (what the user actually last saw),
 * otherwise the previous close.
 */
export function detectVolatilityMove(ctx: SymbolContext): DetectedEvent | null {
  // `??` = "use the left unless it's null/undefined". Measuring from the checkpoint means
  // we report the move since the user LAST LOOKED, not since yesterday — if they were away
  // three days, they want the whole three-day move, not just today's slice.
  const base = ctx.checkpointPrice ?? ctx.prevClose;
  if (!base || base <= 0) return null;  // EDGE CASE: no prior price at all (first ever sighting)

  const sigma = volatility(ctx.bars, 30);
  if (sigma === null) return null;               // no honest baseline -> stay silent
  // EDGE CASE above: newly listed or suspended stock. Dividing by a sigma we don't trust
  // would manufacture a huge z-score, so we say nothing rather than cry wolf.

  const ret = (ctx.price - base) / base;
  // THE line. Dividing the return by this stock's own sigma turns "moved 2%" into
  // "moved 2.8 normal days FOR THIS STOCK". It is why a 1.3% day in HDFC Bank can
  // outrank a 1.97% day in Paytm — same tape, different definition of normal.
  const z = ret / sigma;
  if (Math.abs(z) < THRESHOLDS.volatilityZ) return null;  // inside its normal range -> not news

  const changePct = pct(ctx.price, base);
  return {
    symbol: ctx.symbol,
    type: 'VOLATILITY_MOVE',
    magnitude: z,
    // Clamp: a 40-sigma print (bad tick, corporate action) must not monopolise the digest.
    // The ×2.0 is the weight: an abnormal price move is the strongest single evidence we
    // have that something actually happened, so it outweighs volume (×1.2) and gaps (×1.5).
    baseScore: clamp(Math.abs(z), 0, 8) * 2.0,
    occurredAt: ctx.asOf,
    detail: {
      changePct: r2(changePct), z: r2(z), sigmaPct: r2(sigma * 100),
      basePrice: r2(base), price: r2(ctx.price),
      baseline: ctx.checkpointPrice ? 'checkpoint' : 'previous close',  // say which ruler we used
    },
    // The dedupKey is how we avoid telling someone the same thing twice. Including the
    // session date and the rounded z means the same move on the same day is one event,
    // but a move that grows from 1.6 to 2.4 sigma is genuinely new information.
    dedupKey: `${ctx.symbol}:VOLATILITY_MOVE:${ctx.sessionDate}:${Math.abs(z).toFixed(1)}`,
    // Plain English first. A z-score of 1.6 simply means "1.6x its usual daily move",
    // which needs no statistics background. The sigma itself stays in `detail` for
    // anyone who wants to audit the arithmetic.
    explanation:
      `${short(ctx.symbol)} ${dir(changePct)} ${Math.abs(r1(changePct))}% — ` +
      `${Math.abs(r1(z))}× its usual daily move of about ±${r1(sigma * 100)}%.`,
  };
}

/** VOLUME_SPIKE — conviction behind the move. Price without volume is often noise. */
export function detectVolumeSpike(ctx: SymbolContext): DetectedEvent | null {
  if (ctx.volume === null || ctx.volume <= 0) return null;  // EDGE CASE: feed gave us no volume
  const avg = averageVolume(ctx.bars, 20);
  if (avg === null || avg <= 0) return null;  // EDGE CASE: illiquid/new stock -> no volume baseline

  // Same relative-to-itself idea as the z-score, just expressed as a multiple: 3× normal
  // turnover means something on a sleepy stock and nothing on a heavily traded one.
  const ratio = ctx.volume / avg;
  if (ratio < THRESHOLDS.volumeRatio) return null;  // ordinary day's turnover -> not news

  return {
    symbol: ctx.symbol,
    type: 'VOLUME_SPIKE',
    magnitude: ratio,
    // Weighted lowest of the price signals on purpose: heavy volume alone, with the price
    // going nowhere, usually means an index rebalance or a block trade — not user-facing news.
    baseScore: clamp(ratio, 0, 12) * 1.2,
    occurredAt: ctx.asOf,
    detail: { ratio: r2(ratio), volume: ctx.volume, avgVolume: Math.round(avg) },
    // No magnitude in the key: volume only ever spikes once per session, so one per day.
    dedupKey: `${ctx.symbol}:VOLUME_SPIKE:${ctx.sessionDate}`,
    explanation: `${short(ctx.symbol)} traded ${r1(ratio)}× as many shares as it normally does.`,
  };
}

/** BREACH_52W — a flat, unambiguous, well-understood milestone. Flat weight by design. */
export function detectBreach52w(ctx: SymbolContext): DetectedEvent | null {
  const computed = fiftyTwoWeek(ctx.bars);
  // Prefer the provider's official 52-week figures; fall back to what we compute from our
  // own bars. Our history may be shorter than a year, so the provider is the better source.
  const high = ctx.week52High ?? computed.high;
  const low = ctx.week52Low ?? computed.low;

  // Only counts if the level was crossed SINCE the checkpoint — otherwise we would
  // re-announce a milestone the user has already seen every time they open the app.
  const prior = ctx.checkpointPrice ?? ctx.prevClose;

  // `prior === null ||` means "if we have no idea where it was before, allow the event" —
  // a first-ever sighting at a 52-week high is still worth saying once.
  if (high !== null && ctx.price >= high && (prior === null || prior < high)) {
    return {
      // baseScore 3.0 is flat, not scaled: a 52-week high is a yes/no fact. Breaking it by
      // ₹1 and breaking it by ₹50 are the same headline, so scaling it would be false precision.
      symbol: ctx.symbol, type: 'BREACH_52W', magnitude: 1, baseScore: 3.0, occurredAt: ctx.asOf,
      detail: { level: r2(high), price: r2(ctx.price), side: 'high' },
      dedupKey: `${ctx.symbol}:BREACH_52W_HIGH:${ctx.sessionDate}`,
      explanation: `${short(ctx.symbol)} touched a 52-week high at ₹${r2(ctx.price)}.`,
    };
  }
  // Mirror of the above for the downside. magnitude -1 carries the direction; the score
  // stays 3.0 because a new low is exactly as newsworthy as a new high.
  if (low !== null && ctx.price <= low && (prior === null || prior > low)) {
    return {
      symbol: ctx.symbol, type: 'BREACH_52W', magnitude: -1, baseScore: 3.0, occurredAt: ctx.asOf,
      detail: { level: r2(low), price: r2(ctx.price), side: 'low' },
      dedupKey: `${ctx.symbol}:BREACH_52W_LOW:${ctx.sessionDate}`,
      explanation: `${short(ctx.symbol)} broke to a 52-week low at ₹${r2(ctx.price)}.`,
    };
  }
  return null;  // EDGE CASE: sitting inside the year's range, or we never crossed it today
}

/** GAP_OPEN — overnight repricing. Distinct from an intraday drift of the same size. */
export function detectGapOpen(ctx: SymbolContext): DetectedEvent | null {
  // EDGE CASE: pre-market, or a feed with no opening price -> we can't measure a gap.
  if (ctx.dayOpen === null || ctx.prevClose === null || ctx.prevClose <= 0) return null;
  const sigma = volatility(ctx.bars, 30);
  if (sigma === null) return null;  // EDGE CASE: no trustworthy sigma -> stay silent

  // A gap is the jump from yesterday's close to today's open — the market repricing the
  // stock while it was shut. That usually means real news (results, a deal), which is why
  // it gets its own detector instead of being blurred into the day's total move.
  const gap = (ctx.dayOpen - ctx.prevClose) / ctx.prevClose;
  const z = gap / sigma;                          // again: normalised against this stock's own sigma
  if (Math.abs(z) < THRESHOLDS.gapZ) return null; // an ordinary overnight drift

  const gapPct = gap * 100;
  return {
    symbol: ctx.symbol,
    type: 'GAP_OPEN',
    magnitude: z,
    // ×1.5 sits between volume and the headline move: a gap is strong evidence of news,
    // but the full day's move (which includes it) is the more complete story.
    baseScore: clamp(Math.abs(z), 0, 8) * 1.5,
    occurredAt: ctx.asOf,
    detail: { gapPct: r2(gapPct), z: r2(z), open: r2(ctx.dayOpen), prevClose: r2(ctx.prevClose) },
    dedupKey: `${ctx.symbol}:GAP_OPEN:${ctx.sessionDate}`,  // a session has exactly one open
    explanation:
      `${short(ctx.symbol)} opened ${gapPct >= 0 ? 'up' : 'down'} ${Math.abs(r1(gapPct))}% ` +
      `from where it closed — ${Math.abs(r1(z))}× its usual daily move.`,
  };
}

/** STREAK — persistence. Four sessions one way is a trend, not a wiggle. */
export function detectStreak(ctx: SymbolContext): DetectedEvent | null {
  const streak = directionStreak(ctx.bars);       // signed: + is up days, - is down days
  const days = Math.abs(streak);
  if (days < THRESHOLDS.streakDays) return null;  // EDGE CASE: 1-3 days is ordinary drift, not a trend

  const up = streak > 0;
  return {
    symbol: ctx.symbol,
    type: 'STREAK',
    magnitude: streak,
    // Linear in days on purpose: a 6-day run should outrank a 4-day run, but a streak is a
    // slow-burn story, so even a long one stays below a single violent move (which is ~×2 z).
    baseScore: 0.6 * days,
    occurredAt: ctx.asOf,
    detail: { days, direction: up ? 'up' : 'down' },
    // Day count is in the key, so day 5 of a streak is a new event worth re-surfacing.
    dedupKey: `${ctx.symbol}:STREAK:${ctx.sessionDate}:${days}${up ? 'U' : 'D'}`,
    explanation: `${short(ctx.symbol)} has closed ${up ? 'higher' : 'lower'} ${days} sessions in a row.`,
  };
}

/**
 * REF_DRAWDOWN — the personal signal.
 *
 * Measured against the price when THIS user added the stock, not against the market.
 * Two users watching the same stock can legitimately get different digests, because
 * significance is relative to the person, not just the ticker.
 */
export function detectRefDrawdown(ctx: SymbolContext): DetectedEvent | null {
  if (!ctx.refPrice || ctx.refPrice <= 0) return null;  // EDGE CASE: user never set an entry price
  const change = pct(ctx.price, ctx.refPrice);
  // A flat 10% here rather than a z-score, deliberately: this threshold is about the
  // user's own money, and people think about their position in percent, not in sigma.
  if (Math.abs(change) < THRESHOLDS.refDrawdownPct) return null;

  return {
    symbol: ctx.symbol,
    type: 'REF_DRAWDOWN',
    magnitude: change,
    baseScore: 2.0,                               // flat: crossing the line is the news, not by how much
    occurredAt: ctx.asOf,
    detail: { changePct: r2(change), refPrice: r2(ctx.refPrice), price: r2(ctx.price) },
    // Bucketed by 10% so it re-fires at 10, 20, 30... but not on every tick in between.
    // Note there's no session date in this key: this is a running position, not a daily
    // event, so it should stay quiet for weeks until the next 10% band is crossed.
    dedupKey: `${ctx.symbol}:REF_DRAWDOWN:${Math.trunc(change / 10) * 10}`,
    explanation:
      `${short(ctx.symbol)} is ${change >= 0 ? 'up' : 'down'} ${Math.abs(r1(change))}% ` +
      `since you added it at ₹${r2(ctx.refPrice)}.`,
  };
}

// The registry. Adding a detector is a one-line change here and nothing else, which is the
// point: the scoring layer never needs to know how many detectors exist.
export const ALL_DETECTORS = [
  detectVolatilityMove, detectVolumeSpike, detectBreach52w,
  detectGapOpen, detectStreak, detectRefDrawdown,
] as const;

/** Run every detector. Order is stable so output is deterministic. */
export function detectAll(ctx: SymbolContext): DetectedEvent[] {
  const out: DetectedEvent[] = [];
  for (const d of ALL_DETECTORS) {
    const e = d(ctx);
    if (e) out.push(e);                           // detectors that found nothing return null; skip them
  }
  return out;                                     // can legitimately be empty — a quiet stock
}

/** 'TATAMOTORS.NS' -> 'TATAMOTORS' for display. */
// Users think in tickers, not in exchange suffixes. We keep the suffix internally because
// it's what the data provider keys on, and strip it only at the moment we show a human.
export const short = (s: string): string => s.replace(/\.(NS|BO)$/, '');
