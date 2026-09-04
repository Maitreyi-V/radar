import { describe, it, expect } from 'vitest';
import {
  dailyReturns, mean, stdev, volatility, averageVolume,
  fiftyTwoWeek, directionStreak, clamp, type Bar,
} from './stats.js';

/** Build daily bars from a list of closes. */
const bars = (closes: number[], vol?: number[]): Bar[] =>
  closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: close, high: close, low: close, close,
    volume: vol?.[i] ?? 1000,
  }));

describe('dailyReturns', () => {
  it('computes simple returns between consecutive closes', () => {
    expect(dailyReturns(bars([100, 110, 99]))).toEqual([0.1, -0.1]);
  });

  it('returns nothing for fewer than two bars', () => {
    expect(dailyReturns(bars([100]))).toEqual([]);
    expect(dailyReturns([])).toEqual([]);
  });

  it('skips a zero previous close instead of dividing by zero', () => {
    const rs = dailyReturns(bars([0, 100, 110]));
    expect(rs.every(Number.isFinite)).toBe(true);
    expect(rs).toEqual([0.1]);
  });
});

describe('stdev / mean', () => {
  it('uses the sample (n-1) denominator', () => {
    // population sd of [2,4,4,4,5,5,7,9] is 2; sample sd is ~2.138
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1381, 3);
  });

  it('returns 0 rather than NaN for degenerate input', () => {
    expect(stdev([])).toBe(0);
    expect(stdev([5])).toBe(0);
    expect(mean([])).toBe(0);
  });
});

describe('volatility — the number the whole product rests on', () => {
  it('measures a stock against its own history', () => {
    const steady = volatility(bars([100, 100.5, 100.2, 100.8, 100.4, 100.9, 100.6, 101]));
    const wild = volatility(bars([100, 106, 97, 108, 94, 110, 92, 112]));
    expect(steady).not.toBeNull();
    expect(wild).not.toBeNull();
    // The same absolute move means very different things for these two stocks.
    expect(wild!).toBeGreaterThan(steady! * 5);
  });

  it('returns null for a newly listed stock rather than guessing', () => {
    expect(volatility(bars([100, 101, 102]))).toBeNull();
    expect(volatility([])).toBeNull();
  });

  it('returns null for a flat or suspended stock (zero variance)', () => {
    // Dividing by a zero sigma would yield Infinity and poison every downstream score.
    expect(volatility(bars([50, 50, 50, 50, 50, 50, 50, 50]))).toBeNull();
  });

  it('only considers the trailing window', () => {
    const calm = Array(40).fill(0).map((_, i) => 100 + (i % 2) * 0.1);
    const withAncientCrash = [10, 200, ...calm];
    // The crash is far outside the 30-day window, so it must not inflate sigma.
    expect(volatility(bars(withAncientCrash), 30)).toBeCloseTo(volatility(bars(calm), 30)!, 6);
  });
});

describe('averageVolume', () => {
  it('averages the trailing window', () => {
    expect(averageVolume(bars([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 5)).toBe(30);
  });

  it('returns null when volume is mostly missing', () => {
    const b = bars([1, 2, 3]);
    b.forEach((x) => { x.volume = null; });
    expect(averageVolume(b)).toBeNull();
  });

  it('ignores zero-volume days rather than dragging the average down', () => {
    expect(averageVolume(bars([1, 2, 3, 4], [0, 30, 30, 30]), 4)).toBe(30);
  });
});

describe('fiftyTwoWeek', () => {
  it('finds the extremes across the window', () => {
    const b = bars([100, 150, 80, 120]);
    expect(fiftyTwoWeek(b)).toEqual({ high: 150, low: 80 });
  });

  it('returns nulls for empty history instead of Infinity', () => {
    expect(fiftyTwoWeek([])).toEqual({ high: null, low: null });
  });
});

describe('directionStreak', () => {
  it('counts consecutive up sessions as positive', () => {
    expect(directionStreak(bars([10, 11, 12, 13, 14]))).toBe(4);
  });

  it('counts consecutive down sessions as negative', () => {
    expect(directionStreak(bars([14, 13, 12, 11, 10]))).toBe(-4);
  });

  it('stops counting at the first reversal', () => {
    expect(directionStreak(bars([10, 20, 11, 12, 13]))).toBe(2);
  });

  it('is 0 when the last session was flat', () => {
    expect(directionStreak(bars([10, 11, 12, 12]))).toBe(0);
  });

  it('is 0 without enough history', () => {
    expect(directionStreak(bars([10]))).toBe(0);
  });
});

describe('clamp', () => {
  it('bounds a value both ways', () => {
    expect(clamp(15, 0, 8)).toBe(8);
    expect(clamp(-3, 0, 8)).toBe(0);
    expect(clamp(4, 0, 8)).toBe(4);
  });
});
