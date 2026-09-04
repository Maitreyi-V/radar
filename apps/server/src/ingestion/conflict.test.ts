import { describe, it, expect, beforeEach } from 'vitest';
import { resolveConflict, unconfirmed, SIMULTANEOUS_MS, AGREEMENT_PCT } from './conflict.js';
import type { Quote } from './types.js';

const NOW = Date.UTC(2026, 8, 4, 6, 0);
const q = (over: Partial<Quote> = {}): Quote => ({
  symbol: 'TEST.NS', price: 100, volume: 1000,
  dayHigh: null, dayLow: null, dayOpen: null, prevClose: null,
  week52High: null, week52Low: null,
  asOf: NOW, fetchedAt: NOW, source: 'bse', isSynthetic: false,
  ...over,
});

describe('conflict policy', () => {
  beforeEach(() => { for (const u of unconfirmed.all()) unconfirmed.clear(u.symbol); });

  it('accepts anything when there is no incumbent', () => {
    const r = resolveConflict(q(), undefined);
    expect(r.action).toBe('accept');
  });

  it('treats a newer tick from the SAME source as a normal update', () => {
    const r = resolveConflict(q({ asOf: NOW + 1000, price: 105 }), q());
    expect(r.action).toBe('accept');
  });

  it('applies the monotonic guard within a single source', () => {
    const r = resolveConflict(q({ asOf: NOW - 1000, price: 105 }), q());
    expect(r.action).toBe('keep');
  });

  it('RULE 1: a clearly fresher quote wins, even from the other provider', () => {
    const r = resolveConflict(
      q({ source: 'yahoo', asOf: NOW + SIMULTANEOUS_MS + 1000, price: 130 }),
      q({ source: 'bse' }),
    );
    expect(r.action).toBe('accept');
    expect(r.reason).toMatch(/fresher/);
  });

  it('RULE 1: a clearly staler quote loses', () => {
    const r = resolveConflict(
      q({ source: 'yahoo', asOf: NOW - SIMULTANEOUS_MS - 1000, price: 130 }),
      q({ source: 'bse' }),
    );
    expect(r.action).toBe('keep');
    expect(r.reason).toMatch(/staler/);
  });

  it('RULE 2: near-simultaneous and agreeing -> hold the incumbent, do not flap', () => {
    // 0.3% apart: exchange spread between BSE and NSE, not news.
    const r = resolveConflict(
      q({ source: 'yahoo', asOf: NOW + 2000, price: 100.3 }),
      q({ source: 'bse', price: 100 }),
    );
    expect(r.action).toBe('keep');
    expect(r.unconfirmed).toBe(false);
    expect(r.divergencePct!).toBeLessThanOrEqual(AGREEMENT_PCT);
  });

  it('RULE 3: near-simultaneous and disagreeing -> hold value, flag unconfirmed', () => {
    const r = resolveConflict(
      q({ source: 'yahoo', asOf: NOW + 2000, price: 103 }),   // 3% apart
      q({ source: 'bse', price: 100 }),
    );
    expect(r.action).toBe('keep-unconfirmed');
    expect(r.unconfirmed).toBe(true);
    expect(r.winner.price).toBe(100);            // never adopts the disputed price
    expect(r.reason).toMatch(/disagree by 3\.00%/);
  });

  it('never adopts a disputed price — the incumbent is always the winner', () => {
    for (const p of [90, 95, 105, 200]) {
      const r = resolveConflict(
        q({ source: 'yahoo', asOf: NOW + 1000, price: p }),
        q({ source: 'bse', price: 100 }),
      );
      if (r.action === 'keep-unconfirmed') expect(r.winner.price).toBe(100);
    }
  });

  it('is symmetric about the agreement band', () => {
    const up = resolveConflict(q({ source: 'yahoo', asOf: NOW + 1, price: 100.4 }), q({ price: 100 }));
    const down = resolveConflict(q({ source: 'yahoo', asOf: NOW + 1, price: 99.6 }), q({ price: 100 }));
    expect(up.action).toBe(down.action);
  });
});

describe('unconfirmed registry', () => {
  beforeEach(() => { for (const u of unconfirmed.all()) unconfirmed.clear(u.symbol); });

  it('records and clears a disputed symbol', () => {
    unconfirmed.flag('TEST.NS', 'sources disagree', 3);
    expect(unconfirmed.has('TEST.NS')).toBe(true);
    expect(unconfirmed.all()).toHaveLength(1);
    unconfirmed.clear('TEST.NS');
    expect(unconfirmed.has('TEST.NS')).toBe(false);
  });

  it('keeps the FIRST reason so the flag records when the dispute began', () => {
    unconfirmed.flag('TEST.NS', 'first', 3);
    unconfirmed.flag('TEST.NS', 'second', 9);
    expect(unconfirmed.get('TEST.NS')!.reason).toBe('first');
  });
});
