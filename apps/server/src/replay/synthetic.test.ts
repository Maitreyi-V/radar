import { describe, it, expect } from 'vitest';
import { generateSession, SESSION_MINUTES } from './synthetic.js';
import { mulberry32, gaussian, hashSeed } from './random.js';
import { volatility, type Bar } from '../significance/stats.js';

const params = {
  symbol: 'TEST.NS', prevClose: 100, dailySigma: 0.02, avgVolume: 1_000_000,
};

describe('seeded randomness', () => {
  it('is reproducible for a given seed', () => {
    const a = Array.from({ length: 5 }, mulberry32(42));
    const b = Array.from({ length: 5 }, mulberry32(42));
    expect(a).toEqual(b);
  });

  it('differs between seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('produces roughly standard-normal draws', () => {
    const rand = mulberry32(7);
    const xs = Array.from({ length: 20_000 }, () => gaussian(rand));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sd).toBeCloseTo(1, 1);
  });

  it('hashes a symbol to a stable seed', () => {
    expect(hashSeed('TCS.NS')).toBe(hashSeed('TCS.NS'));
    expect(hashSeed('TCS.NS')).not.toBe(hashSeed('INFY.NS'));
  });
});

describe('generateSession', () => {
  it('produces one tick per session minute', () => {
    expect(generateSession(params)).toHaveLength(SESSION_MINUTES);
  });

  it('is deterministic for a given seed — so replays are reproducible', () => {
    const a = generateSession({ ...params, seed: 99 });
    const b = generateSession({ ...params, seed: 99 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps prices positive — the reason we model log-returns, not raw returns', () => {
    // A very high sigma would drive an additive model negative; GBM cannot.
    const ticks = generateSession({ ...params, dailySigma: 0.4, seed: 3 });
    expect(ticks.every((t) => t.price > 0)).toBe(true);
  });

  it('accumulates volume monotonically across the session', () => {
    const ticks = generateSession({ ...params, seed: 5 });
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.volume!).toBeGreaterThanOrEqual(ticks[i - 1]!.volume!);
    }
  });

  it('tracks the running high and low correctly', () => {
    const ticks = generateSession({ ...params, seed: 11 });
    const last = ticks[ticks.length - 1]!;
    const prices = ticks.map((t) => t.price);
    expect(last.dayHigh).toBeCloseTo(Math.max(...prices), 1);
    expect(last.dayLow).toBeCloseTo(Math.min(...prices), 1);
  });

  it('marks every tick as synthetic — never passed off as real', () => {
    expect(generateSession(params).every((t) => t.isSynthetic && t.source === 'synthetic')).toBe(true);
  });

  it('REALISM: a stock simulated with higher sigma really does move more', () => {
    const calm = generateSession({ ...params, dailySigma: 0.005, seed: 1 });
    const wild = generateSession({ ...params, dailySigma: 0.05, seed: 1 });
    const spread = (ts: typeof calm) => (Math.max(...ts.map(t => t.price)) - Math.min(...ts.map(t => t.price))) / 100;
    // Per-stock sigma is what makes replay a valid test of the significance engine;
    // a single global sigma would assume away the problem the engine solves.
    expect(spread(wild)).toBeGreaterThan(spread(calm) * 3);
  });

  it('recovers the input sigma when measured back out of the generated path', () => {
    // Generate 30 independent sessions and measure the close-to-close sigma.
    const closes: number[] = [];
    let prev = 100;
    for (let d = 0; d < 30; d++) {
      const ticks = generateSession({ ...params, prevClose: prev, dailySigma: 0.02, seed: 1000 + d, jumpProb: 0 });
      prev = ticks[ticks.length - 1]!.price;
      closes.push(prev);
    }
    const bars: Bar[] = closes.map((c, i) => ({ date: `d${i}`, open: c, high: c, low: c, close: c, volume: 1 }));
    const measured = volatility(bars, 30)!;
    // Wide band: 30 samples is a small estimator, but it must land in the right order
    // of magnitude or the simulator is not calibrated to the stock at all.
    expect(measured).toBeGreaterThan(0.005);
    expect(measured).toBeLessThan(0.06);
  });
});
