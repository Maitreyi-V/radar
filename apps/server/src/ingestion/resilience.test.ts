import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from './circuitBreaker.js';
import { AdaptiveRate } from './adaptiveRate.js';
import { TokenBucket, backoffMs } from './rateLimiter.js';
import { parseAson, parseGraphDttm } from './adapters/bse.js';

describe('CircuitBreaker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays closed while calls succeed', () => {
    const b = new CircuitBreaker('p', 3, 60_000);
    for (let i = 0; i < 10; i++) { expect(b.canRequest()).toBe(true); b.onSuccess(); }
    expect(b.state).toBe('CLOSED');
  });

  it('opens after the threshold and then FAILS FAST without touching the network', () => {
    const b = new CircuitBreaker('p', 3, 60_000);
    for (let i = 0; i < 3; i++) { b.canRequest(); b.onFailure('boom'); }
    expect(b.state).toBe('OPEN');
    // This is the property that matters: a dead provider stops costing us a timeout
    // on every single cycle.
    expect(b.canRequest()).toBe(false);
  });

  it('half-opens after the cooldown and admits exactly ONE probe', () => {
    const b = new CircuitBreaker('p', 3, 60_000);
    for (let i = 0; i < 3; i++) { b.canRequest(); b.onFailure('boom'); }
    vi.advanceTimersByTime(60_001);
    expect(b.state).toBe('HALF_OPEN');
    expect(b.canRequest()).toBe(true);
    expect(b.canRequest()).toBe(false);   // second caller is refused
  });

  it('recovers on a successful probe', () => {
    const b = new CircuitBreaker('p', 3, 60_000);
    for (let i = 0; i < 3; i++) { b.canRequest(); b.onFailure('boom'); }
    vi.advanceTimersByTime(60_001);
    b.canRequest(); b.onSuccess();
    expect(b.state).toBe('CLOSED');
    expect(b.canRequest()).toBe(true);
  });

  it('re-opens if the probe fails, without waiting for the full threshold again', () => {
    const b = new CircuitBreaker('p', 3, 60_000);
    for (let i = 0; i < 3; i++) { b.canRequest(); b.onFailure('boom'); }
    vi.advanceTimersByTime(60_001);
    b.canRequest(); b.onFailure('still down');
    expect(b.state).toBe('OPEN');
  });
});

describe('AdaptiveRate (AIMD)', () => {
  it('backs off multiplicatively on throttling — the only way out of a penalty box', () => {
    const r = new AdaptiveRate(1_000, 300_000, 10_000);
    r.onThrottle();
    expect(r.current).toBe(20_000);
    r.onThrottle();
    expect(r.current).toBe(40_000);
  });

  it('speeds up additively, and only after a run of clean successes', () => {
    const r = new AdaptiveRate(1_000, 300_000, 10_000, 1_000, 3);
    r.onSuccess(); r.onSuccess();
    expect(r.current).toBe(10_000);        // not yet
    r.onSuccess();
    expect(r.current).toBe(9_000);         // one step faster
  });

  it('a single throttle undoes many successes — deliberately asymmetric', () => {
    const r = new AdaptiveRate(1_000, 300_000, 10_000, 1_000, 1);
    for (let i = 0; i < 5; i++) r.onSuccess();
    expect(r.current).toBe(5_000);
    r.onThrottle();
    expect(r.current).toBe(10_000);
  });

  it('respects both bounds', () => {
    const r = new AdaptiveRate(1_000, 20_000, 10_000, 1_000, 1);
    for (let i = 0; i < 100; i++) r.onSuccess();
    expect(r.current).toBe(1_000);
    for (let i = 0; i < 100; i++) r.onThrottle();
    expect(r.current).toBe(20_000);
  });
});

describe('TokenBucket', () => {
  it('allows an initial burst up to capacity, then paces', async () => {
    const b = new TokenBucket(3, 100);   // fast refill to keep the test quick
    const t0 = Date.now();
    await Promise.all([b.take(), b.take(), b.take()]);
    expect(Date.now() - t0).toBeLessThan(50);   // burst is immediate
  });
});

describe('backoffMs', () => {
  it('grows exponentially and stays within the cap', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const v = backoffMs(attempt, 500, 20_000);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(20_000);
    }
  });

  it('is jittered, so retries from many clients do not synchronise', () => {
    const seen = new Set(Array.from({ length: 40 }, () => backoffMs(5)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('BSE timestamp parsing — provider clocks are IST with no zone marker', () => {
  it('parses the quote "Ason" format as IST, not as server-local time', () => {
    const t = parseAson('04 Sep 26 | 12:05');
    expect(t).toBe(Date.UTC(2026, 8, 4, 12, 5) - 5.5 * 3600_000);
  });

  it('parses the intraday graph format', () => {
    const t = parseGraphDttm('Fri Sep 04 2026 09:15:59');
    expect(t).toBe(Date.UTC(2026, 8, 4, 9, 15, 59) - 5.5 * 3600_000);
  });

  it('returns null on junk rather than an Invalid Date', () => {
    expect(parseAson('not a date')).toBeNull();
    expect(parseAson(undefined)).toBeNull();
    expect(parseGraphDttm('')).toBeNull();
  });
});
