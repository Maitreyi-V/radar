import type { SymbolContext, DetectedEvent } from './types.js';
import { volatility, averageVolume, fiftyTwoWeek, directionStreak, clamp } from './stats.js';

/**
 * Detectors: pure (SymbolContext) -> DetectedEvent | null.
 *
 * Every detector must return null rather than throw when the data cannot support a
 * confident answer. A missing signal is honest; a fabricated one destroys trust.
 * Thresholds live here as named constants so they are reviewable in one place.
 */

export const THRESHOLDS = {
  volatilityZ: 1.5,        // sigma
  volumeRatio: 2.5,        // x 20-day average
  gapZ: 1.5,               // sigma
  streakDays: 4,           // consecutive sessions
  refDrawdownPct: 10,      // % from the user's entry reference
} as const;

const pct = (a: number, b: number): number => ((a - b) / b) * 100;
const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const dir = (n: number): string => (n >= 0 ? 'rose' : 'fell');

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
  const base = ctx.checkpointPrice ?? ctx.prevClose;
  if (!base || base <= 0) return null;

  const sigma = volatility(ctx.bars, 30);
  if (sigma === null) return null;               // no honest baseline -> stay silent

  const ret = (ctx.price - base) / base;
  const z = ret / sigma;
  if (Math.abs(z) < THRESHOLDS.volatilityZ) return null;

  const changePct = pct(ctx.price, base);
  return {
    symbol: ctx.symbol,
    type: 'VOLATILITY_MOVE',
    magnitude: z,
    // Clamp: a 40-sigma print (bad tick, corporate action) must not monopolise the digest.
    baseScore: clamp(Math.abs(z), 0, 8) * 2.0,
    occurredAt: ctx.asOf,
    detail: {
      changePct: r2(changePct), z: r2(z), sigmaPct: r2(sigma * 100),
      basePrice: r2(base), price: r2(ctx.price),
      baseline: ctx.checkpointPrice ? 'checkpoint' : 'previous close',
    },
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
  if (ctx.volume === null || ctx.volume <= 0) return null;
  const avg = averageVolume(ctx.bars, 20);
  if (avg === null || avg <= 0) return null;

  const ratio = ctx.volume / avg;
  if (ratio < THRESHOLDS.volumeRatio) return null;

  return {
    symbol: ctx.symbol,
    type: 'VOLUME_SPIKE',
    magnitude: ratio,
    baseScore: clamp(ratio, 0, 12) * 1.2,
    occurredAt: ctx.asOf,
    detail: { ratio: r2(ratio), volume: ctx.volume, avgVolume: Math.round(avg) },
    dedupKey: `${ctx.symbol}:VOLUME_SPIKE:${ctx.sessionDate}`,
    explanation: `${short(ctx.symbol)} traded ${r1(ratio)}× as many shares as it normally does.`,
  };
}

/** BREACH_52W — a flat, unambiguous, well-understood milestone. Flat weight by design. */
export function detectBreach52w(ctx: SymbolContext): DetectedEvent | null {
  const computed = fiftyTwoWeek(ctx.bars);
  const high = ctx.week52High ?? computed.high;
  const low = ctx.week52Low ?? computed.low;

  // Only counts if the level was crossed SINCE the checkpoint — otherwise we would
  // re-announce a milestone the user has already seen every time they open the app.
  const prior = ctx.checkpointPrice ?? ctx.prevClose;

  if (high !== null && ctx.price >= high && (prior === null || prior < high)) {
    return {
      symbol: ctx.symbol, type: 'BREACH_52W', magnitude: 1, baseScore: 3.0, occurredAt: ctx.asOf,
      detail: { level: r2(high), price: r2(ctx.price), side: 'high' },
      dedupKey: `${ctx.symbol}:BREACH_52W_HIGH:${ctx.sessionDate}`,
      explanation: `${short(ctx.symbol)} touched a 52-week high at ₹${r2(ctx.price)}.`,
    };
  }
  if (low !== null && ctx.price <= low && (prior === null || prior > low)) {
    return {
      symbol: ctx.symbol, type: 'BREACH_52W', magnitude: -1, baseScore: 3.0, occurredAt: ctx.asOf,
      detail: { level: r2(low), price: r2(ctx.price), side: 'low' },
      dedupKey: `${ctx.symbol}:BREACH_52W_LOW:${ctx.sessionDate}`,
      explanation: `${short(ctx.symbol)} broke to a 52-week low at ₹${r2(ctx.price)}.`,
    };
  }
  return null;
}

/** GAP_OPEN — overnight repricing. Distinct from an intraday drift of the same size. */
export function detectGapOpen(ctx: SymbolContext): DetectedEvent | null {
  if (ctx.dayOpen === null || ctx.prevClose === null || ctx.prevClose <= 0) return null;
  const sigma = volatility(ctx.bars, 30);
  if (sigma === null) return null;

  const gap = (ctx.dayOpen - ctx.prevClose) / ctx.prevClose;
  const z = gap / sigma;
  if (Math.abs(z) < THRESHOLDS.gapZ) return null;

  const gapPct = gap * 100;
  return {
    symbol: ctx.symbol,
    type: 'GAP_OPEN',
    magnitude: z,
    baseScore: clamp(Math.abs(z), 0, 8) * 1.5,
    occurredAt: ctx.asOf,
    detail: { gapPct: r2(gapPct), z: r2(z), open: r2(ctx.dayOpen), prevClose: r2(ctx.prevClose) },
    dedupKey: `${ctx.symbol}:GAP_OPEN:${ctx.sessionDate}`,
    explanation:
      `${short(ctx.symbol)} opened ${gapPct >= 0 ? 'up' : 'down'} ${Math.abs(r1(gapPct))}% ` +
      `from where it closed — ${Math.abs(r1(z))}× its usual daily move.`,
  };
}

/** STREAK — persistence. Four sessions one way is a trend, not a wiggle. */
export function detectStreak(ctx: SymbolContext): DetectedEvent | null {
  const streak = directionStreak(ctx.bars);
  const days = Math.abs(streak);
  if (days < THRESHOLDS.streakDays) return null;

  const up = streak > 0;
  return {
    symbol: ctx.symbol,
    type: 'STREAK',
    magnitude: streak,
    baseScore: 0.6 * days,
    occurredAt: ctx.asOf,
    detail: { days, direction: up ? 'up' : 'down' },
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
  if (!ctx.refPrice || ctx.refPrice <= 0) return null;
  const change = pct(ctx.price, ctx.refPrice);
  if (Math.abs(change) < THRESHOLDS.refDrawdownPct) return null;

  return {
    symbol: ctx.symbol,
    type: 'REF_DRAWDOWN',
    magnitude: change,
    baseScore: 2.0,
    occurredAt: ctx.asOf,
    detail: { changePct: r2(change), refPrice: r2(ctx.refPrice), price: r2(ctx.price) },
    // Bucketed by 10% so it re-fires at 10, 20, 30... but not on every tick in between.
    dedupKey: `${ctx.symbol}:REF_DRAWDOWN:${Math.trunc(change / 10) * 10}`,
    explanation:
      `${short(ctx.symbol)} is ${change >= 0 ? 'up' : 'down'} ${Math.abs(r1(change))}% ` +
      `since you added it at ₹${r2(ctx.refPrice)}.`,
  };
}

export const ALL_DETECTORS = [
  detectVolatilityMove, detectVolumeSpike, detectBreach52w,
  detectGapOpen, detectStreak, detectRefDrawdown,
] as const;

/** Run every detector. Order is stable so output is deterministic. */
export function detectAll(ctx: SymbolContext): DetectedEvent[] {
  const out: DetectedEvent[] = [];
  for (const d of ALL_DETECTORS) {
    const e = d(ctx);
    if (e) out.push(e);
  }
  return out;
}

/** 'TATAMOTORS.NS' -> 'TATAMOTORS' for display. */
export const short = (s: string): string => s.replace(/\.(NS|BO)$/, '');
