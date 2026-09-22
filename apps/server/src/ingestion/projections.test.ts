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
/** IST session OPEN falls in — 09:15 on Fri 4 Sep 2026. Novelty keys are session-scoped. */
const SESSION = '2026-09-04';

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
    // Volume drifts 4.0x -> 4.1x of average. It is cumulative, so it rises on every
    // tick; an immaterial gain must NOT reopen a condition the user is caught up on.
    writeQuote(quote(100.5, OPEN + 2 * step, { volume: 4100 }));
    expect(events(OPEN + 2 * step)).toEqual([]);
    // The row still records the newer reading — we hold back the clock, not the numbers.
    const stored = db.prepare(`SELECT payload, occurred_at, last_updated_at FROM market_events`)
      .get() as { payload: string; occurred_at: number; last_updated_at: number };
    expect(JSON.parse(stored.payload).magnitude).toBeCloseTo(4.1, 10);
    expect(stored.last_updated_at).toBe(OPEN + step);
  });

  it('reopens a condition the user is caught up on once it strengthens materially', () => {
    writeQuote(quote(130, OPEN, { volume: 3000 }));
    writeQuote(quote(100, OPEN + step, { volume: 4000 }));
    checkpoint(OPEN + step);
    // 4.0x -> 5.0x is a 25% gain in weight: genuinely new information, so it surfaces
    // again even though the event FIRST occurred well before the checkpoint.
    writeQuote(quote(100.5, OPEN + 2 * step, { volume: 5000 }));
    const surfaced = events(OPEN + 2 * step);
    // The pre-checkpoint price extremum of 130 still stays buried.
    expect(surfaced.map((e) => e.type)).toEqual(['VOLUME_SPIKE']);
    expect(surfaced[0]?.magnitude).toBe(5);
    // occurred_at never moves; last_updated_at is what earned it a second showing.
    expect(surfaced[0]?.occurredAt).toBe(OPEN);
    expect(surfaced[0]?.lastUpdatedAt).toBe(OPEN + 2 * step);
    expect(count('market_events')).toBe(1);
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
    const { recentDigestEventKeys } = await import('../digest/events.js');
    writeQuote(quote(103, OPEN, { volume: 3000 }));
    expect(recentDigestEventKeys('w', OPEN + step)).toEqual([]);
    digest(OPEN);
    digest(OPEN);
    expect(recentDigestEventKeys('w', OPEN + step).map((keys) => keys.sort())).toEqual([[`${symbol}:VOLATILITY_MOVE:${SESSION}`, `${symbol}:VOLUME_SPIKE:${SESSION}`]]);
    expect(recentDigestEventKeys('another-watchlist', OPEN + step)).toEqual([]);
  });

  it('keeps a new event type eligible while damping repeats only in their own watchlist', async () => {
    const { recordDigestExposure, recentDigestEventKeys } = await import('../digest/events.js');
    for (let i = 1; i <= 3; i++) {
      recordDigestExposure('w', `prior-${i}`, OPEN - i * step, [{ symbol, type: 'VOLUME_SPIKE', sessionDate: SESSION }]);
    }
    writeQuote(quote(100, OPEN, { volume: 3000, prevClose: 99, week52High: 100 }));
    const options = { userId: 'u', watchlistId: 'w', now: OPEN };
    const first = buildDigest(options);
    expect(first.cards[0]?.events.map((e) => e.type)).toEqual(['BREACH_52W']);
    expect(first.cards[0]?.events[0]?.noveltyFactor).toBe(1);
    expect(buildDigest(options)).toEqual(first);
    expect(recentDigestEventKeys('w', OPEN + 1)[0]).toEqual([`${symbol}:BREACH_52W:${SESSION}`]);

    db.prepare(`INSERT INTO watchlists VALUES ('other','u','Other',1,?)`).run(OPEN);
    db.prepare(`INSERT INTO watchlist_items VALUES ('other',?,?,100)`).run(symbol, OPEN - 1);
    db.prepare(`INSERT INTO checkpoints VALUES ('other-cp','u','other',?,?)`)
      .run(OPEN - 1, JSON.stringify({ [symbol]: { price: 100 } }));
    try {
      const other = buildDigest({ ...options, watchlistId: 'other' });
      expect(other.cards[0]?.events.find((e) => e.type === 'VOLUME_SPIKE')?.noveltyFactor).toBe(1);
    } finally { db.prepare(`DELETE FROM watchlists WHERE id = 'other'`).run(); }
  });

  it('adds event-specific history to existing databases without guessing legacy event types', async () => {
    const { default: SQLite } = await import('better-sqlite3');
    const { applyColumnMigrations } = await import('../db/migrate.js');
    const legacy = new SQLite(':memory:');
    try {
      legacy.exec(`CREATE TABLE symbols (symbol TEXT, bse_code TEXT, mktcap REAL, tracked INTEGER);
        CREATE TABLE digest_exposures (watchlist_id TEXT, checkpoint_id TEXT, shown_at INTEGER, symbols TEXT);
        INSERT INTO digest_exposures VALUES ('w', 'old', 1, '["TEST.NS"]');`);
      expect(applyColumnMigrations(legacy)).toContain('digest_exposures.event_keys');
      expect(applyColumnMigrations(legacy)).toEqual([]);
      expect(legacy.prepare('SELECT event_keys FROM digest_exposures').get()).toEqual({ event_keys: '[]' });
    } finally { legacy.close(); }
  });

  it('strengthens the drill-down log in place instead of logging the same event twice', async () => {
    const { recordEvents, eventsForSymbol } = await import('../digest/events.js');
    const scored = (magnitude: number, score: number, at: number) => ({
      symbol, type: 'VOLUME_SPIKE' as const, magnitude, baseScore: magnitude * 1.2, score,
      occurredAt: OPEN, lastUpdatedAt: at, recency: 1, noveltyFactor: 1,
      detail: { ratio: magnitude }, dedupKey: `${symbol}:VOLUME_SPIKE:${SESSION}`,
      sessionDate: SESSION, explanation: `${magnitude}x`,
    });

    expect(recordEvents([scored(3, 6, OPEN)])).toBe(1);
    // A bigger recurrence carrying a LOWER ranked score — recency and novelty have
    // damped it since the first showing. It must still win, because strength is the raw
    // magnitude; ranking on `score` here would freeze the 3x reading in place forever.
    expect(recordEvents([scored(5, 2, OPEN + step)])).toBe(0);
    expect(count('events')).toBe(1);
    const logged = eventsForSymbol(symbol, 0)[0];
    expect(logged?.magnitude).toBe(5);
    expect(logged?.occurredAt).toBe(OPEN);
    expect(logged?.updatedAt).toBe(OPEN + step);

    // Re-recording the same reading is a refresh, not an update: the clock must not move.
    recordEvents([scored(5, 2, OPEN + step)]);
    expect(eventsForSymbol(symbol, 0)[0]?.updatedAt).toBe(OPEN + step);
    expect(count('events')).toBe(1);
  });

  it('seeds last-updated tracking in existing databases from what they already knew', async () => {
    const { default: SQLite } = await import('better-sqlite3');
    const { applyColumnMigrations } = await import('../db/migrate.js');
    const legacy = new SQLite(':memory:');
    try {
      legacy.exec(`CREATE TABLE symbols (symbol TEXT, bse_code TEXT, mktcap REAL, tracked INTEGER);
        CREATE TABLE market_events (stream TEXT, symbol TEXT, dedup_key TEXT, occurred_at INTEGER, peak_at INTEGER, payload TEXT);
        CREATE TABLE events (id TEXT, symbol TEXT, type TEXT, magnitude REAL, score REAL, occurred_at INTEGER, detail TEXT, dedup_key TEXT);
        INSERT INTO market_events VALUES ('market','TEST.NS','k',100,180,'{}');
        INSERT INTO events VALUES ('e1','TEST.NS','VOLUME_SPIKE',3,4,100,'{}','k');`);
      const applied = applyColumnMigrations(legacy);
      expect(applied).toContain('market_events.last_updated_at');
      expect(applied).toContain('events.updated_at');
      // Seeded rather than left at 0, so a pre-existing row keeps behaving exactly as
      // it did before the column existed instead of looking permanently un-updated.
      expect(legacy.prepare('SELECT last_updated_at FROM market_events').get()).toEqual({ last_updated_at: 180 });
      expect(legacy.prepare('SELECT updated_at FROM events').get()).toEqual({ updated_at: 100 });
      expect(applyColumnMigrations(legacy)).toEqual([]);
    } finally { legacy.close(); }
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
