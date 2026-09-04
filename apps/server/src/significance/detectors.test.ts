import { describe, it, expect } from 'vitest';
import {
  detectVolatilityMove, detectVolumeSpike, detectBreach52w,
  detectGapOpen, detectStreak, detectRefDrawdown, detectAll, THRESHOLDS,
} from './detectors.js';
import type { SymbolContext } from './types.js';
import type { Bar } from './stats.js';

const bars = (closes: number[], vol?: number[]): Bar[] =>
  closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: close, high: close, low: close, close, volume: vol?.[i] ?? 1000,
  }));

/** Alternating +/- `pct` gives a clean, known daily sigma. */
const withSigma = (pct: number, n = 40, base = 100): Bar[] =>
  bars(Array.from({ length: n }, (_, i) => base * (1 + (i % 2 === 0 ? pct : -pct))));

const ctx = (over: Partial<SymbolContext> = {}): SymbolContext => ({
  symbol: 'TEST.NS',
  bars: withSigma(0.01),
  price: 100, volume: 1000,
  dayOpen: 100, prevClose: 100,
  week52High: null, week52Low: null,
  asOf: Date.UTC(2026, 8, 4, 10, 0),
  sessionDate: '2026-09-04',
  ...over,
});

describe('VOLATILITY_MOVE', () => {
  it('does not fire below the z threshold', () => {
    // sigma ~2%; a 1% move is only ~0.5 sigma
    expect(detectVolatilityMove(ctx({ bars: withSigma(0.02), prevClose: 100, price: 101 }))).toBeNull();
  });

  it('fires above the z threshold and explains itself with numbers', () => {
    const e = detectVolatilityMove(ctx({ bars: withSigma(0.01), prevClose: 100, price: 105 }));
    expect(e).not.toBeNull();
    expect(e!.type).toBe('VOLATILITY_MOVE');
    expect(Math.abs(e!.magnitude)).toBeGreaterThanOrEqual(THRESHOLDS.volatilityZ);
    expect(e!.explanation).toMatch(/rose 5%/);
    expect(e!.explanation).toMatch(/its usual daily move/);
    // No statistics jargon in user-facing copy — sigma lives in `detail`, not the sentence.
    expect(e!.explanation).not.toMatch(/σ|z-score|standard deviation/);
  });

  it('THE THESIS: an identical % move fires for a calm stock and not for a wild one', () => {
    const move = { prevClose: 100, price: 103 };            // +3% for BOTH stocks
    const calm = detectVolatilityMove(ctx({ bars: withSigma(0.005), ...move }));  // sigma ~1%/day
    const wild = detectVolatilityMove(ctx({ bars: withSigma(0.05), ...move }));   // sigma ~10%/day

    expect(calm).not.toBeNull();                 // ~3 sigma here — a genuine event
    expect(Math.abs(calm!.magnitude)).toBeGreaterThan(2.5);
    expect(wild).toBeNull();                     // ~0.3 sigma there — an ordinary day

    // This is the entire product argument: a fixed % threshold cannot separate these,
    // because the move is identical. Only normalising by each stock's own history can.
  });

  it('THE THESIS, inverted: a SMALLER move can outrank a larger one', () => {
    const smallMoveCalmStock = detectVolatilityMove(ctx({ bars: withSigma(0.005), prevClose: 100, price: 102 }));
    const bigMoveWildStock   = detectVolatilityMove(ctx({ bars: withSigma(0.05), prevClose: 100, price: 108 }));
    expect(smallMoveCalmStock).not.toBeNull();
    expect(bigMoveWildStock).toBeNull();
    // +2% surfaced, +8% did not. Exactly what a percentage-sorted watchlist gets wrong.
  });

  it('measures from the checkpoint when there is one, not the previous close', () => {
    const e = detectVolatilityMove(ctx({
      bars: withSigma(0.01), prevClose: 100, checkpointPrice: 90, price: 96,
    }));
    expect(e).not.toBeNull();
    expect(e!.detail.baseline).toBe('checkpoint');
    expect(e!.detail.basePrice).toBe(90);
  });

  it('stays silent with too little history instead of inventing a sigma', () => {
    expect(detectVolatilityMove(ctx({ bars: bars([100, 120]), price: 150 }))).toBeNull();
  });

  it('stays silent for a flat/suspended stock rather than dividing by zero', () => {
    expect(detectVolatilityMove(ctx({ bars: bars(Array(30).fill(100)), price: 130 }))).toBeNull();
  });

  it('clamps an absurd print so one bad tick cannot monopolise the digest', () => {
    const e = detectVolatilityMove(ctx({ bars: withSigma(0.01), prevClose: 100, price: 100000 }));
    expect(e!.baseScore).toBeLessThanOrEqual(8 * 2.0);
  });
});

describe('VOLUME_SPIKE', () => {
  it('fires at or above the ratio threshold', () => {
    const e = detectVolumeSpike(ctx({ bars: bars(Array(25).fill(100), Array(25).fill(1000)), volume: 3000 }));
    expect(e).not.toBeNull();
    expect(e!.magnitude).toBeCloseTo(3, 5);
    expect(e!.explanation).toMatch(/3× as many shares/);
  });

  it('does not fire just below the threshold', () => {
    expect(detectVolumeSpike(ctx({ bars: bars(Array(25).fill(100), Array(25).fill(1000)), volume: 2400 }))).toBeNull();
  });

  it('stays silent when volume is unknown', () => {
    expect(detectVolumeSpike(ctx({ volume: null }))).toBeNull();
  });
});

describe('BREACH_52W', () => {
  it('fires when price crosses the high since the checkpoint', () => {
    const e = detectBreach52w(ctx({ week52High: 200, week52Low: 50, checkpointPrice: 190, price: 205 }));
    expect(e!.type).toBe('BREACH_52W');
    expect(e!.detail.side).toBe('high');
  });

  it('fires on a low breach', () => {
    const e = detectBreach52w(ctx({ week52High: 200, week52Low: 50, checkpointPrice: 60, price: 45 }));
    expect(e!.detail.side).toBe('low');
  });

  it('does NOT re-announce a level the user had already seen breached', () => {
    // Already above the high at checkpoint time — not news any more.
    expect(detectBreach52w(ctx({ week52High: 200, week52Low: 50, checkpointPrice: 210, price: 205 }))).toBeNull();
  });

  it('falls back to computing the range from history when the provider omits it', () => {
    const e = detectBreach52w(ctx({
      bars: bars([100, 150, 80, 120]), week52High: null, week52Low: null,
      checkpointPrice: 140, price: 155,
    }));
    expect(e).not.toBeNull();
    expect(e!.detail.level).toBe(150);
  });
});

describe('GAP_OPEN', () => {
  it('fires on a large overnight gap', () => {
    const e = detectGapOpen(ctx({ bars: withSigma(0.01), prevClose: 100, dayOpen: 106 }));
    expect(e!.type).toBe('GAP_OPEN');
    expect(e!.explanation).toMatch(/opened up/);
  });

  it('does not fire on a small gap', () => {
    expect(detectGapOpen(ctx({ bars: withSigma(0.02), prevClose: 100, dayOpen: 100.5 }))).toBeNull();
  });

  it('stays silent without an open price', () => {
    expect(detectGapOpen(ctx({ dayOpen: null }))).toBeNull();
  });
});

describe('STREAK', () => {
  it('fires at four consecutive sessions', () => {
    const e = detectStreak(ctx({ bars: bars([10, 11, 12, 13, 14]) }));
    expect(e!.magnitude).toBe(4);
    expect(e!.explanation).toMatch(/higher 4 sessions/);
  });

  it('does not fire at three', () => {
    expect(detectStreak(ctx({ bars: bars([10, 11, 12, 13]) }))).toBeNull();
  });
});

describe('REF_DRAWDOWN — the personal signal', () => {
  it('fires past ±10% from the user\'s own entry price', () => {
    const e = detectRefDrawdown(ctx({ refPrice: 100, price: 88 }));
    expect(e!.type).toBe('REF_DRAWDOWN');
    expect(e!.explanation).toMatch(/down 12%.*since you added it/);
  });

  it('does not fire inside the band', () => {
    expect(detectRefDrawdown(ctx({ refPrice: 100, price: 105 }))).toBeNull();
  });

  it('is silent when the user has no reference price', () => {
    expect(detectRefDrawdown(ctx({ refPrice: undefined, price: 50 }))).toBeNull();
  });

  it('buckets the dedup key by 10% so it re-fires at 20% but not on every tick', () => {
    const a = detectRefDrawdown(ctx({ refPrice: 100, price: 88 }))!;
    const b = detectRefDrawdown(ctx({ refPrice: 100, price: 89 }))!;
    const c = detectRefDrawdown(ctx({ refPrice: 100, price: 79 }))!;
    expect(a.dedupKey).toBe(b.dedupKey);   // same bucket -> one event
    expect(a.dedupKey).not.toBe(c.dedupKey);
  });
});

describe('detectAll', () => {
  it('returns nothing for a genuinely uneventful stock', () => {
    expect(detectAll(ctx({ bars: withSigma(0.02), price: 100, prevClose: 100, volume: 1000 }))).toEqual([]);
  });

  it('stacks multiple signals on one dramatic day', () => {
    const events = detectAll(ctx({
      bars: bars(Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1)), Array(40).fill(1000)),
      prevClose: 100, dayOpen: 108, price: 112, volume: 5000,
      week52High: 105, week52Low: 50, checkpointPrice: 100, refPrice: 90,
    }));
    const types = events.map((e) => e.type);
    expect(types).toContain('VOLATILITY_MOVE');
    expect(types).toContain('VOLUME_SPIKE');
    expect(types).toContain('BREACH_52W');
    expect(types).toContain('GAP_OPEN');
    expect(types).toContain('REF_DRAWDOWN');
  });

  it('every surfaced event carries a plain-English explanation — no unexplained badges', () => {
    const events = detectAll(ctx({
      bars: withSigma(0.01), prevClose: 100, price: 110, volume: 5000, refPrice: 90,
    }));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.explanation.length).toBeGreaterThan(10);
      expect(e.explanation).toMatch(/\d/);           // must cite its numbers
      expect(e.dedupKey).toContain(e.symbol);
    }
  });

  it('is deterministic — same input, same output', () => {
    const c = ctx({ bars: withSigma(0.01), prevClose: 100, price: 110, volume: 5000 });
    expect(JSON.stringify(detectAll(c))).toBe(JSON.stringify(detectAll(c)));
  });
});
