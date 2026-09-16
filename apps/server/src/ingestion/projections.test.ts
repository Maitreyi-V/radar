import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Quote } from './types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-projections-'));
process.env.RADAR_DB = path.join(tmp, 'test.db');
let db: typeof import('../db/index.js')['db'];
let writeQuote: typeof import('./store.js')['writeQuote'];
let projections: typeof import('./projections.js');
let buildDigest: typeof import('../digest/build.js')['buildDigest'];
let clearReplay: typeof import('../replay/engine.js')['clearStrandedReplayRows'];
let detectors: typeof import('../significance/detectors.js');
const OPEN = Date.UTC(2026, 8, 4, 3, 45);
const step = 30_000;
const symbol = 'TEST.NS';

function quote(price: number, at: number, extra: Partial<Quote> = {}): Quote {
  return { symbol, price, asOf: at, fetchedAt: at, source: 'test', isSynthetic: false,
    volume: 1000, dayHigh: price, dayLow: price, dayOpen: 100, prevClose: 100,
    week52High: 200, week52Low: 50, ...extra };
}
function checkpoint(at = OPEN - 1, price = 100, acknowledgedEventKeys: string[] = []): void {
  db.prepare(`DELETE FROM checkpoints`).run();
  db.prepare(`INSERT INTO checkpoints VALUES ('cp','u','w',?,?)`)
    .run(at, JSON.stringify({ [symbol]: { price, acknowledgedEventKeys } }));
}
function digest(now: number, replay = false) {
  return buildDigest({ userId: 'u', watchlistId: 'w', now, sensitivity: 0,
    dataMode: replay ? 'REPLAY' : 'CURRENT' });
}
function events(now: number, replay = false) { return digest(now, replay).cards.flatMap((c) => c.events); }
function count(table: string): number { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }

beforeAll(async () => {
  ({ db } = await import('../db/index.js'));
  ({ writeQuote } = await import('./store.js'));
  projections = await import('./projections.js');
  ({ buildDigest } = await import('../digest/build.js'));
  ({ clearStrandedReplayRows: clearReplay } = await import('../replay/engine.js'));
  detectors = await import('../significance/detectors.js');
  db.prepare(`INSERT INTO users VALUES ('u','test@test','x',?)`).run(OPEN);
  db.prepare(`INSERT INTO watchlists VALUES ('w','u','test',1,?)`).run(OPEN);
  db.prepare(`INSERT INTO watchlist_items VALUES ('w',?,?,100)`).run(symbol, OPEN - 1);
});
afterAll(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => {
  vi.restoreAllMocks();
  for (const table of ['market_events', 'session_summaries', 'quotes', 'projection_progress', 'events', 'digest_exposures', 'daily_bars']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  for (let i = 0; i < 31; i++) {
    const date = new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0, 10);
    const close = i % 2 ? 100.5 : 99.5;
    db.prepare(`INSERT INTO daily_bars VALUES (?,?,?,?,?,?,?)`).run(symbol, date, close, 200, 50, close, 1000);
  }
  checkpoint();
});

describe('ingestion projections and digest reads', () => {
  it('detects once during ingestion and never reruns shared detectors on digest reads', () => {
    const spy = vi.spyOn(detectors, 'detectVolumeSpike');
    writeQuote(quote(100, OPEN, { volume: 3000 }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(count('market_events')).toBe(1);
    expect(count('digest_exposures')).toBe(0);
    const first = digest(OPEN);
    expect(first.cards[0]?.events[0]?.type).toBe('VOLUME_SPIKE');
    expect(digest(OPEN)).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps first crossing, strongest observation and current price as separate facts', () => {
    writeQuote(quote(100, OPEN));
    writeQuote(quote(103, OPEN + step, { volume: 3000 }));
    writeQuote(quote(120, OPEN + 2 * step, { volume: 6000 }));
    writeQuote(quote(101, OPEN + 3 * step, { volume: 6000 }));
    const d = digest(OPEN + 3 * step);
    const move = d.cards[0]?.events.find((e) => e.type === 'VOLATILITY_MOVE');
    const volume = d.cards[0]?.events.find((e) => e.type === 'VOLUME_SPIKE');
    expect(d.cards[0]?.price).toBe(101);
    expect(move?.occurredAt).toBe(OPEN + step);
    expect(move?.detail.peakAt).toBe(OPEN + 2 * step);
    expect(move?.detail.changePct).toBe(20);
    expect(volume?.occurredAt).toBe(OPEN + step);
    expect(volume?.detail.peakAt).toBe(OPEN + 2 * step);
    expect(volume?.magnitude).toBe(6);
    expect(count('market_events')).toBe(1);
  });

  it('excludes pre-checkpoint extrema and conditions already active at a midday checkpoint', () => {
    writeQuote(quote(130, OPEN, { volume: 3000 }));
    writeQuote(quote(100, OPEN + step, { volume: 4000 }));
    checkpoint(OPEN + step);
    writeQuote(quote(100.5, OPEN + 2 * step, { volume: 5000 }));
    expect(events(OPEN + 2 * step)).toEqual([]);
  });

  it('never leaks a future peak or volume into an earlier as-of digest', () => {
    writeQuote(quote(103, OPEN, { volume: 3000 }));
    const first = digest(OPEN);
    writeQuote(quote(120, OPEN + step, { volume: 8000 }));
    expect(digest(OPEN)).toEqual(first);
  });

  it('does not refresh a persistent shared event timestamp on later ticks', () => {
    writeQuote(quote(100, OPEN, { volume: 3000, dayOpen: 110 }));
    writeQuote(quote(100, OPEN + step, { volume: 4000, dayOpen: 110 }));
    for (const event of projections.marketEvents(symbol, 'market', 0, OPEN + step)) {
      expect(event.occurredAt).toBe(OPEN);
    }
  });

  it('dates a new reference bucket at its crossing after the old bucket was acknowledged', () => {
    checkpoint(OPEN - 1, 112, [`${symbol}:REF_DRAWDOWN:10`]);
    writeQuote(quote(112, OPEN));
    writeQuote(quote(119, OPEN + step));
    writeQuote(quote(121, OPEN + 2 * step));
    writeQuote(quote(125, OPEN + 3 * step));
    const event = events(OPEN + 3 * step).find((e) => e.type === 'REF_DRAWDOWN');
    expect(event?.occurredAt).toBe(OPEN + 2 * step);
    expect(event?.detail.peakAt).toBe(OPEN + 3 * step);
  });

  it('does not project duplicate, stale, or disputed quotes', () => {
    const q = quote(100, OPEN);
    expect(writeQuote(q)).toBe('inserted');
    expect(writeQuote(q)).toBe('duplicate');
    expect(writeQuote(quote(150, OPEN - step))).toBe('stale');
    expect(writeQuote(quote(150, OPEN, { source: 'other' }))).toBe('disputed');
    expect(count('quotes')).toBe(1);
    const s = db.prepare(`SELECT high_quote FROM session_summaries`).get() as { high_quote: string };
    expect(JSON.parse(s.high_quote).price).toBe(100);
    expect(count('market_events')).toBe(0);
  });

  it('rolls the quote back if projection persistence fails', () => {
    db.exec(`CREATE TRIGGER projection_failure BEFORE INSERT ON session_summaries
      BEGIN SELECT RAISE(ABORT, 'projection failed'); END`);
    try {
      expect(() => writeQuote(quote(100, OPEN))).toThrow('projection failed');
      expect(count('quotes')).toBe(0);
    } finally { db.exec('DROP TRIGGER projection_failure'); }
  });

  it('replay sees emitted ticks only and reset removes every replay projection', () => {
    writeQuote(quote(130, OPEN, { volume: 9000 })); // complete tape is present
    expect(events(OPEN, true)).toEqual([]);
    writeQuote(quote(100, OPEN, { source: 'replay', marketAsOf: OPEN, dayHigh: 130, dayLow: 80 }));
    expect(events(OPEN, true)).toEqual([]);
    writeQuote(quote(103, OPEN + step, { source: 'replay', marketAsOf: OPEN + step, volume: 3000 }));
    expect(events(OPEN + step, true).some((e) => e.type === 'VOLUME_SPIKE')).toBe(true);
    expect(count('digest_exposures')).toBe(0);
    expect(clearReplay()).toBe(2);
    expect(events(OPEN + step, true)).toEqual([]);
    expect(count('session_summaries')).toBe(1);
    expect(count('market_events')).toBe(1);
    expect(count('market_event_versions')).toBe(1);
  });

  it('uses the original market date for replay history, excluding future daily bars', () => {
    for (let i = 4; i <= 20; i++) {
      db.prepare(`INSERT INTO daily_bars VALUES (?,?,?,?,?,?,?)`)
        .run(symbol, `2026-09-${String(i).padStart(2, '0')}`, 100, 200, 50, 100, 100_000);
    }
    const replayAt = Date.UTC(2026, 9, 1, 6);
    writeQuote(quote(103, replayAt, { source: 'replay', marketAsOf: OPEN, volume: 3000 }));
    const volume = events(replayAt, true).find((e) => e.type === 'VOLUME_SPIKE');
    expect(volume).toBeDefined();
    expect(Number(volume?.detail.avgVolume)).toBeLessThan(100_000);
    const s = db.prepare(`SELECT bars FROM session_summaries`).get() as { bars: string };
    expect(JSON.parse(s.bars).every((b: { date: string }) => b.date < '2026-09-04')).toBe(true);
  });

  it('backfills an existing database once without changing quote history', () => {
    writeQuote(quote(120, OPEN, { volume: 3000 }));
    db.prepare(`DELETE FROM market_events`).run();
    db.prepare(`DELETE FROM session_summaries`).run();
    db.prepare(`DELETE FROM projection_progress`).run();
    expect(projections.backfillProjections()).toBe(1);
    expect(projections.backfillProjections()).toBe(0);
    expect(count('quotes')).toBe(1);
    expect(count('session_summaries')).toBe(1);
    expect(events(OPEN).some((e) => e.type === 'VOLUME_SPIKE')).toBe(true);
  });

  it('novelty records only displayed cards for this watchlist, not global market events', async () => {
    const { recentDigestSymbols } = await import('../digest/events.js');
    writeQuote(quote(103, OPEN, { volume: 3000 }));
    expect(recentDigestSymbols('w', OPEN + step)).toEqual([]);
    digest(OPEN);
    digest(OPEN);
    expect(recentDigestSymbols('w', OPEN + step)).toEqual([[symbol]]);
    expect(recentDigestSymbols('another-watchlist', OPEN + step)).toEqual([]);
  });

  it('personalises the same stored market data for different checkpoint prices', () => {
    writeQuote(quote(110, OPEN));
    expect(events(OPEN).some((e) => e.type === 'VOLATILITY_MOVE')).toBe(true);
    checkpoint(OPEN - 1, 110, [`${symbol}:REF_DRAWDOWN:10`]);
    expect(events(OPEN)).toEqual([]);
    expect(count('session_summaries')).toBe(1);
  });

  it('can explicitly rebuild derived state after a historical baseline correction', () => {
    writeQuote(quote(100, OPEN, { volume: 3000 }));
    expect(count('market_events')).toBe(1);
    db.prepare(`UPDATE daily_bars SET volume = 10000`).run();
    expect(projections.rebuildProjections()).toBe(1);
    expect(count('quotes')).toBe(1);
    expect(count('market_events')).toBe(0);
  });

  it('uses session summaries and score bounds for a long absence instead of replaying detectors', () => {
    const spy = vi.spyOn(detectors, 'detectVolumeSpike');
    for (let day = 0; day < 90; day++) {
      for (let tick = 0; tick < 12; tick++) {
        writeQuote(quote(tick === 5 ? 120 : 100, OPEN + day * 86400_000 + tick * step));
      }
    }
    const ingestionCalls = spy.mock.calls.length;
    const now = OPEN + 89 * 86400_000 + 12 * step;
    const d = buildDigest({ userId: 'u', watchlistId: 'w', now });
    expect(spy).toHaveBeenCalledTimes(ingestionCalls);
    expect(count('session_summaries')).toBe(90);
    expect(d.cards[0]?.events.some((e) => e.detail.changePct === 20)).toBe(true);
  });
});
