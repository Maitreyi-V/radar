import { describe, it, expect } from 'vitest';
import {
  recencyDecay, novelty, scoreEvent, rank,
  HALF_LIFE_MS, NOVELTY_FACTOR, ATTENTION_THRESHOLD,
} from './score.js';
import type { DetectedEvent } from './types.js';

const NOW = Date.UTC(2026, 8, 4, 10, 0);

const ev = (over: Partial<DetectedEvent> = {}): DetectedEvent => ({
  symbol: 'TEST.NS', type: 'VOLATILITY_MOVE',
  magnitude: 2, baseScore: 4, occurredAt: NOW,
  detail: {}, dedupKey: 'TEST.NS:X:1', explanation: 'something happened',
  ...over,
});

describe('recencyDecay', () => {
  it('is 1 for something that just happened', () => {
    expect(recencyDecay(NOW, NOW)).toBe(1);
  });

  it('halves every 24 hours', () => {
    expect(recencyDecay(NOW - HALF_LIFE_MS, NOW)).toBeCloseTo(0.5, 10);
    expect(recencyDecay(NOW - 2 * HALF_LIFE_MS, NOW)).toBeCloseTo(0.25, 10);
  });

  it('never exceeds 1 for a future timestamp (clock skew)', () => {
    expect(recencyDecay(NOW + 60_000, NOW)).toBe(1);
  });
});

describe('novelty — stops one noisy stock monopolising the digest', () => {
  it('is 1 for a symbol not seen recently', () => {
    expect(novelty('TEST.NS', [['A.NS'], ['B.NS']])).toBe(1);
  });

  it('damps once per recent appearance', () => {
    expect(novelty('TEST.NS', [['TEST.NS']])).toBeCloseTo(NOVELTY_FACTOR, 10);
    expect(novelty('TEST.NS', [['TEST.NS'], ['TEST.NS']])).toBeCloseTo(NOVELTY_FACTOR ** 2, 10);
  });

  it('lets a fresh stock outrank a repeat offender at equal raw strength', () => {
    const history = [['NOISY.NS'], ['NOISY.NS'], ['NOISY.NS']];
    const noisy = scoreEvent(ev({ symbol: 'NOISY.NS' }), { now: NOW, recentDigestSymbols: history });
    const fresh = scoreEvent(ev({ symbol: 'FRESH.NS' }), { now: NOW, recentDigestSymbols: history });
    expect(fresh.score).toBeGreaterThan(noisy.score);
  });
});

describe('rank', () => {
  it('orders by score, strongest first', () => {
    const out = rank([
      ev({ symbol: 'LOW.NS', baseScore: 2, dedupKey: 'a' }),
      ev({ symbol: 'HIGH.NS', baseScore: 9, dedupKey: 'b' }),
      ev({ symbol: 'MID.NS', baseScore: 5, dedupKey: 'c' }),
    ], { now: NOW });
    expect(out.map((e) => e.symbol)).toEqual(['HIGH.NS', 'MID.NS', 'LOW.NS']);
  });

  it('drops everything below the attention threshold', () => {
    const out = rank([ev({ baseScore: ATTENTION_THRESHOLD - 0.01 })], { now: NOW });
    expect(out).toEqual([]);
  });

  it('prefers a recent moderate event over an old strong one', () => {
    const out = rank([
      ev({ symbol: 'OLD.NS', baseScore: 8, occurredAt: NOW - 3 * HALF_LIFE_MS, dedupKey: 'old' }),
      ev({ symbol: 'NEW.NS', baseScore: 4, occurredAt: NOW, dedupKey: 'new' }),
    ], { now: NOW });
    expect(out[0]!.symbol).toBe('NEW.NS');   // 8 * 0.125 = 1.0 vs 4 * 1 = 4.0
  });

  it('breaks ties on symbol so ordering is reproducible', () => {
    const a = rank([ev({ symbol: 'B.NS', dedupKey: '1' }), ev({ symbol: 'A.NS', dedupKey: '2' })], { now: NOW });
    const b = rank([ev({ symbol: 'A.NS', dedupKey: '2' }), ev({ symbol: 'B.NS', dedupKey: '1' })], { now: NOW });
    expect(a.map((e) => e.symbol)).toEqual(b.map((e) => e.symbol));
  });

  it('returns an empty digest rather than padding it — the honest empty state', () => {
    expect(rank([], { now: NOW })).toEqual([]);
  });

  it('exposes its arithmetic so a score can be audited', () => {
    const [s] = rank([ev({ baseScore: 4, occurredAt: NOW - HALF_LIFE_MS })], { now: NOW });
    expect(s!.recency).toBeCloseTo(0.5, 10);
    expect(s!.noveltyFactor).toBe(1);
    expect(s!.score).toBeCloseTo(4 * 0.5 * 1, 10);
  });
});
