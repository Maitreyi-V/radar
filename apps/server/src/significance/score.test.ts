import { describe, it, expect } from 'vitest';
import {
  recencyDecay, novelty, noveltyKey, scoreEvent, rank,
  HALF_LIFE_MS, NOVELTY_FACTOR, ATTENTION_THRESHOLD,
} from './score.js';
import type { DetectedEvent } from './types.js';

const NOW = Date.UTC(2026, 8, 4, 10, 0);
/** The IST session NOW falls in — 15:30 on Fri 4 Sep 2026. */
const SESSION = '2026-09-04';
const NEXT_SESSION = '2026-09-07';   // the following Monday

const ev = (over: Partial<DetectedEvent> = {}): DetectedEvent => ({
  symbol: 'TEST.NS', type: 'VOLATILITY_MOVE',
  magnitude: 2, baseScore: 4, occurredAt: NOW,
  detail: {}, dedupKey: 'TEST.NS:X:1', sessionDate: SESSION,
  explanation: 'something happened',
  ...over,
});

describe('recencyDecay — measured in TRADING time, not wall-clock', () => {
  // NOW is Fri 4 Sep 2026, 15:30 IST — the closing bell.
  const FRI_CLOSE = Date.UTC(2026, 8, 4, 10, 0);
  const FRI_OPEN = Date.UTC(2026, 8, 4, 3, 45);      // 09:15 IST same day
  const THU_CLOSE = Date.UTC(2026, 8, 3, 10, 0);
  const THU_OPEN = Date.UTC(2026, 8, 3, 3, 45);

  it('is 1 for something that just happened', () => {
    expect(recencyDecay(FRI_CLOSE, FRI_CLOSE)).toBe(1);
  });

  it('halves over one full trading session', () => {
    expect(recencyDecay(FRI_OPEN, FRI_CLOSE)).toBeCloseTo(0.5, 6);
  });

  it('halves again over a second session', () => {
    // Thursday open -> Friday close spans two complete sessions.
    expect(recencyDecay(THU_OPEN, FRI_CLOSE)).toBeCloseTo(0.25, 6);
  });

  it('ignores the overnight gap — only trading hours count', () => {
    // Thursday's close to Friday's close is ONE session of trading, despite 24h passing.
    expect(recencyDecay(THU_CLOSE, FRI_CLOSE)).toBeCloseTo(0.5, 6);
  });

  it('DOES NOT DECAY ACROSS A WEEKEND — nothing traded, so nothing got staler', () => {
    const sunday = Date.UTC(2026, 8, 6, 12, 0);
    expect(recencyDecay(FRI_CLOSE, sunday)).toBe(1);
    // This is not a nicety. With wall-clock decay a genuine Friday event scored 3.19 at
    // the close and 0.46 by Monday morning — it silently vanished from the digest over a
    // weekend in which the market never opened.
    const scored = scoreEvent(ev({ baseScore: 3.2, occurredAt: FRI_CLOSE }), { now: sunday });
    expect(scored.score).toBeGreaterThan(ATTENTION_THRESHOLD);
  });

  it('resumes decaying once the market reopens', () => {
    const monMidSession = Date.UTC(2026, 8, 7, 5, 30);   // Mon 11:00 IST
    const d = recencyDecay(FRI_CLOSE, monMidSession);
    expect(d).toBeLessThan(1);        // Monday's trading hours do count
    expect(d).toBeGreaterThan(0.5);   // but only ~1h45m of them
  });

  it('never exceeds 1 for a future timestamp (clock skew)', () => {
    expect(recencyDecay(FRI_CLOSE + 60_000, FRI_CLOSE)).toBe(1);
  });
});

describe('novelty — scoped to stock and event type within a watchlist', () => {
  it('is 1 for a stock/event-type pair not seen recently', () => {
    expect(novelty(ev(), [[`A.NS:VOLATILITY_MOVE:${SESSION}`], [`B.NS:VOLATILITY_MOVE:${SESSION}`]])).toBe(1);
  });

  it('damps once per prior visit containing the same stock and event type', () => {
    const key = noveltyKey(ev());
    expect(novelty(ev(), [[key, key]])).toBeCloseTo(NOVELTY_FACTOR, 10);
    expect(novelty(ev(), [[key], [key]])).toBeCloseTo(NOVELTY_FACTOR ** 2, 10);
  });

  it('lets a fresh stock outrank a repeat at equal raw strength', () => {
    const key = noveltyKey(ev({ symbol: 'NOISY.NS' }));
    const history = [[key], [key], [key]];
    const noisy = scoreEvent(ev({ symbol: 'NOISY.NS' }), { now: NOW, recentDigestEventKeys: history });
    const fresh = scoreEvent(ev({ symbol: 'FRESH.NS' }), { now: NOW, recentDigestEventKeys: history });
    expect(fresh.score).toBeGreaterThan(noisy.score);
  });

  it('does not damp a new event type for the same stock', () => {
    const history = [[`TEST.NS:VOLUME_SPIKE:${SESSION}`], [`TEST.NS:VOLUME_SPIKE:${SESSION}`]];
    expect(scoreEvent(ev({ type: 'VOLUME_SPIKE' }), { now: NOW, recentDigestEventKeys: history }).noveltyFactor).toBeCloseTo(0.49);
    expect(scoreEvent(ev({ type: 'BREACH_52W' }), { now: NOW, recentDigestEventKeys: history }).noveltyFactor).toBe(1);
    expect(scoreEvent(ev({ type: 'REF_DRAWDOWN' }), { now: NOW, recentDigestEventKeys: history }).noveltyFactor).toBe(1);
  });

  it('does not carry damping across trading days — novelty is a within-session budget', () => {
    // Shown three times yesterday. Today's spike is a NEW event and must open at full
    // strength; punishing it for yesterday would bury genuinely fresh news.
    const yesterday = [[`TEST.NS:VOLUME_SPIKE:${SESSION}`], [`TEST.NS:VOLUME_SPIKE:${SESSION}`], [`TEST.NS:VOLUME_SPIKE:${SESSION}`]];
    const today = ev({ type: 'VOLUME_SPIKE', sessionDate: NEXT_SESSION });
    expect(novelty(today, yesterday)).toBe(1);
    // ...while a repeat within the SAME session still damps, once per prior visit.
    expect(novelty(ev({ type: 'VOLUME_SPIKE' }), yesterday)).toBeCloseTo(NOVELTY_FACTOR ** 3, 10);
  });

  it('keeps damping a Friday event reopened over the weekend — it is still the same event', () => {
    // The key follows the EVENT's session, not the viewing date, so Saturday and Sunday
    // visits do not each look brand new.
    const friday = ev({ sessionDate: SESSION });
    expect(noveltyKey(friday)).toBe(`TEST.NS:VOLATILITY_MOVE:${SESSION}`);
    expect(novelty(friday, [[noveltyKey(friday)], [noveltyKey(friday)]])).toBeCloseTo(NOVELTY_FACTOR ** 2, 10);
  });

  it('does not interpret legacy symbol-only history as evidence for an event type', () => {
    expect(novelty(ev(), [['TEST.NS']])).toBe(1);
  });
});

describe('recency anchors to the last strength change', () => {
  it('scores a strengthened event as news from when it strengthened, not first detection', () => {
    const FRI_OPEN = Date.UTC(2026, 8, 4, 3, 45);          // 09:15 IST
    // Same event: first detected at the open, intensified right before we scored it.
    const stale = scoreEvent(ev({ occurredAt: FRI_OPEN }), { now: NOW });
    const restated = scoreEvent(ev({ occurredAt: FRI_OPEN, lastUpdatedAt: NOW }), { now: NOW });
    expect(restated.recency).toBe(1);
    expect(restated.recency).toBeGreaterThan(stale.recency);
    expect(restated.score).toBeGreaterThan(stale.score);
  });

  it('falls back to occurredAt for an event that never restated', () => {
    const e = ev({ occurredAt: NOW });
    expect(scoreEvent(e, { now: NOW }).recency).toBe(scoreEvent({ ...e, lastUpdatedAt: NOW }, { now: NOW }).recency);
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
