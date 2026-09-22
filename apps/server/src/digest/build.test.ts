import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Integration test for the digest.
 *
 * Runs against a REAL SQLite database in a temp dir, not mocks — the digest is mostly
 * SQL plus the significance engine, and mocking the database would test neither. The
 * env var is set before the dynamic imports because db/index.ts opens the file at
 * module-evaluation time.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-test-'));
process.env.RADAR_DB = path.join(TMP, 'test.db');

let db: typeof import('../db/index.js')['db'];
let buildDigest: typeof import('./build.js')['buildDigest'];
let freshnessOf: typeof import('./build.js')['freshnessOf'];
let writeQuote: typeof import('../ingestion/store.js')['writeQuote'];
let writeCheckpoint: typeof import('../api/watchlists.js')['writeCheckpoint'];

const NOW = Date.UTC(2026, 8, 4, 6, 0);        // 2026-09-04 11:30 IST — market OPEN
const CHECKPOINT = NOW - 18 * 3600_000;
const USER = 'u1', WL = 'w1';

/** 40 alternating closes -> a known, stable sigma of roughly `pct`. */
function seedBars(symbol: string, pct: number, base = 100, volume = 1000): void {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO daily_bars (symbol, bar_date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 40; i++) {
    const close = base * (1 + (i % 2 === 0 ? pct : -pct));
    ins.run(symbol, `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, close, close, close, close, volume);
  }
}

function seedQuote(symbol: string, price: number, opts: { volume?: number; prevClose?: number; asOf?: number } = {}): void {
  writeQuote({ symbol, price, volume: opts.volume ?? 1000, dayHigh: price, dayLow: price,
    dayOpen: opts.prevClose ?? 100, prevClose: opts.prevClose ?? 100,
    week52High: null, week52Low: null, asOf: opts.asOf ?? NOW - 30_000,
    fetchedAt: NOW, source: 'test', isSynthetic: false });
}

beforeAll(async () => {
  ({ db } = await import('../db/index.js'));
  ({ writeQuote } = await import('../ingestion/store.js'));
  ({ buildDigest, freshnessOf } = await import('./build.js'));
  ({ writeCheckpoint } = await import('../api/watchlists.js'));

  db.prepare(`INSERT INTO users (id,email,pw_hash,created_at) VALUES (?,?,?,?)`).run(USER, 'a@b.c', 'x', NOW);
  db.prepare(`INSERT INTO watchlists (id,user_id,name,version,created_at) VALUES (?,?,?,1,?)`).run(WL, USER, 'W', NOW);
});

afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function addItem(symbol: string, refPrice: number | null = null): void {
  db.prepare(
    `INSERT OR REPLACE INTO watchlist_items (watchlist_id,symbol,added_at,ref_price) VALUES (?,?,?,?)`,
  ).run(WL, symbol, CHECKPOINT, refPrice);
}

function setCheckpoint(snapshot: Record<string, { price: number }>): void {
  db.prepare(`DELETE FROM checkpoints WHERE watchlist_id = ?`).run(WL);
  db.prepare(
    `INSERT INTO checkpoints (id,user_id,watchlist_id,taken_at,snapshot) VALUES (?,?,?,?,?)`,
  ).run('c1', USER, WL, CHECKPOINT, JSON.stringify(snapshot));
}

describe('freshnessOf', () => {
  it('reports LIVE, DELAYED and STALE by data age while the market is open', () => {
    expect(freshnessOf(NOW - 10_000, NOW)).toBe('LIVE');
    expect(freshnessOf(NOW - 300_000, NOW)).toBe('DELAYED');
    expect(freshnessOf(NOW - 3_600_000, NOW)).toBe('STALE');
  });

  it('says MARKET CLOSED on a weekend regardless of age', () => {
    const sunday = Date.UTC(2026, 8, 6, 6, 0);
    expect(freshnessOf(sunday - 1000, sunday)).toBe('MARKET_CLOSED');
  });

  it('labels intentionally frozen demo data as RECORDED', () => {
    expect(freshnessOf(NOW - 10_000, NOW, 'bse', 'RECORDED')).toBe('RECORDED');
  });
});

describe('buildDigest', () => {
  it('renders the honest empty state when nothing crossed the threshold', () => {
    addItem('CALM.NS');
    seedBars('CALM.NS', 0.02);          // sigma ~4%/day
    seedQuote('CALM.NS', 100.5, { prevClose: 100 });
    setCheckpoint({ 'CALM.NS': { price: 100 } });

    const d = buildDigest({ userId: USER, watchlistId: WL, now: NOW });
    expect(d.isQuiet).toBe(true);
    expect(d.cards).toEqual([]);
    expect(d.quietCount).toBe(1);
    expect(d.sinceLabel).toMatch(/18 hours ago/);
  });

  it('surfaces a genuine move with an explanation that cites its numbers', () => {
    seedBars('MOVER.NS', 0.005);        // sigma ~1%/day
    addItem('MOVER.NS');
    seedQuote('MOVER.NS', 106, { prevClose: 100 });
    setCheckpoint({ 'CALM.NS': { price: 100 }, 'MOVER.NS': { price: 100 } });

    const d = buildDigest({ userId: USER, watchlistId: WL, now: NOW });
    expect(d.isQuiet).toBe(false);
    expect(d.cards[0]!.symbol).toBe('MOVER.NS');
    expect(d.cards[0]!.headline).toMatch(/its usual daily move/);
    expect(d.cards[0]!.headline).toMatch(/6%/);
    expect(d.quietSymbols).toContain('CALM.NS');   // the quiet one is still accounted for
  });

  it('preserves a meaningful intraday move that reversed before the user returned', () => {
    const wl = 'transient-wl';
    const symbol = 'TRANSIENT.NS';
    const checkpointAt = Date.UTC(2026, 8, 4, 3, 45); // 09:15 IST
    const spikeAt = Date.UTC(2026, 8, 4, 4, 30);      // 10:00 IST
    const normalAt = Date.UTC(2026, 8, 4, 5, 59);     // 11:29 IST

    db.prepare(`INSERT INTO watchlists (id,user_id,name,version,created_at) VALUES (?,?,?,1,?)`)
      .run(wl, USER, 'Transient move', checkpointAt);
    db.prepare(
      `INSERT INTO watchlist_items (watchlist_id,symbol,added_at,ref_price) VALUES (?,?,?,?)`,
    ).run(wl, symbol, checkpointAt, 100);
    seedBars(symbol, 0.005); // about 1% daily sigma
    db.prepare(
      `INSERT INTO checkpoints (id,user_id,watchlist_id,taken_at,snapshot) VALUES (?,?,?,?,?)`,
    ).run('transient-cp', USER, wl, checkpointAt, JSON.stringify({ [symbol]: { price: 100 } }));

    seedQuote(symbol, 120, { prevClose: 100, asOf: spikeAt });
    seedQuote(symbol, 101, { prevClose: 100, asOf: normalAt });

    const d = buildDigest({ userId: USER, watchlistId: wl, now: NOW });
    const move = d.cards[0]?.events.find((event) => event.type === 'VOLATILITY_MOVE');

    expect(d.cards[0]?.symbol).toBe(symbol);
    expect(d.cards[0]?.price).toBe(101);                // current state is honest
    expect(d.cards[0]?.changePct).toBe(1);
    expect(move?.occurredAt).toBe(spikeAt);             // recency uses the real crossing
    expect(move?.detail.peakAt).toBe(spikeAt);
    expect(move?.detail.changePct).toBe(20);            // the transient peak is retained
    expect(move?.recency).toBeLessThan(1);
  });

  it('keeps a recorded demo deterministic and labels its time context honestly', () => {
    const d = buildDigest({
      userId: USER, watchlistId: WL, now: NOW,
      dataMode: 'RECORDED', dataSessionDate: '2026-09-04',
    });
    expect(d.dataMode).toBe('RECORDED');
    expect(d.dataSessionDate).toBe('2026-09-04');
    expect(d.sinceLabel).toBe('at the previous close in this demo scenario');
    expect(d.cards.every((c) => c.freshness === 'RECORDED')).toBe(true);
  });

  it('uses scenario language while replaying instead of wall-clock age', () => {
    const d = buildDigest({
      userId: USER, watchlistId: WL, now: NOW,
      dataMode: 'REPLAY', dataSessionDate: '2026-09-04',
    });
    expect(d.sinceLabel).toBe('at the previous close in this replay scenario');
  });

  it('respects the attention budget and buckets the rest', () => {
    for (let i = 0; i < 8; i++) {
      const s = `M${i}.NS`;
      seedBars(s, 0.005);
      addItem(s);
      seedQuote(s, 106 + i, { prevClose: 100 });
    }
    setCheckpoint(Object.fromEntries(
      [...Array(8)].map((_, i) => [`M${i}.NS`, { price: 100 }]),
    ));

    const d = buildDigest({ userId: USER, watchlistId: WL, now: NOW, limit: 5 });
    expect(d.cards).toHaveLength(5);
    // Nothing is lost: every watched symbol is either a card or counted as quiet.
    const total = db.prepare(`SELECT COUNT(*) n FROM watchlist_items WHERE watchlist_id = ?`).get(WL) as { n: number };
    expect(d.cards.length + d.quietCount + d.unavailable.length).toBe(total.n);
  });

  it('surfaces symbols it has no price for instead of hiding them', () => {
    addItem('GHOST.NS');
    const d = buildDigest({ userId: USER, watchlistId: WL, now: NOW });
    expect(d.unavailable).toContain('GHOST.NS');
  });

  it('IS IDEMPOTENT ACROSS REFRESHES — viewing the digest must not change it', () => {
    // Regression guard. Building a digest records its events; novelty damping then read
    // those same events back and scored the stocks 0.7x on the next view, so cards
    // silently dropped out on reload (observed live: 4 cards became 3). Novelty must
    // only consider PRIOR visits, never the window being computed.
    const first = buildDigest({ userId: USER, watchlistId: WL, now: NOW });
    const second = buildDigest({ userId: USER, watchlistId: WL, now: NOW });
    const third = buildDigest({ userId: USER, watchlistId: WL, now: NOW });

    expect(second.cards.map((c) => c.symbol)).toEqual(first.cards.map((c) => c.symbol));
    expect(third.cards.map((c) => c.symbol)).toEqual(first.cards.map((c) => c.symbol));
    expect(second.cards.map((c) => c.score)).toEqual(first.cards.map((c) => c.score));
    expect(third.quietCount).toBe(first.quietCount);
  });

  it('is a pure function of stored state — recomputing gives an identical result', () => {
    const a = buildDigest({ userId: USER, watchlistId: WL, now: NOW });
    const b = buildDigest({ userId: USER, watchlistId: WL, now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('treats a first-ever visit as having no checkpoint, not as an error', () => {
    db.prepare(`DELETE FROM checkpoints WHERE watchlist_id = ?`).run(WL);
    const d = buildDigest({ userId: USER, watchlistId: WL, now: NOW });
    expect(d.since).toBeNull();
    expect(d.sinceLabel).toBe('your first visit');
  });

  it('Mark caught up acknowledges persistent events until their identity changes', () => {
    const wl = 'ack-wl';
    const symbol = 'ACK.NS';
    db.prepare(`INSERT INTO watchlists (id,user_id,name,version,created_at) VALUES (?,?,?,1,?)`)
      .run(wl, USER, 'Acknowledgement', NOW);
    db.prepare(
      `INSERT INTO watchlist_items (watchlist_id,symbol,added_at,ref_price) VALUES (?,?,?,?)`,
    ).run(wl, symbol, CHECKPOINT, 80);
    seedBars(symbol, 0.02); // high enough volatility that ref-price is the only event
    seedQuote(symbol, 100, { prevClose: 100, asOf: Date.now() - 30_000 }); // +25% since added
    db.prepare(
      `INSERT INTO checkpoints (id,user_id,watchlist_id,taken_at,snapshot) VALUES (?,?,?,?,?)`,
    ).run('ack-before', USER, wl, CHECKPOINT, JSON.stringify({ [symbol]: { price: 100 } }));

    const before = buildDigest({ userId: USER, watchlistId: wl, now: Date.now(), sensitivity: 0.8 });
    expect(before.cards[0]?.events.some((e) => e.type === 'REF_DRAWDOWN')).toBe(true);

    writeCheckpoint(USER, wl);
    const stored = db.prepare(
      `SELECT snapshot FROM checkpoints WHERE watchlist_id = ? ORDER BY taken_at DESC LIMIT 1`,
    ).get(wl) as { snapshot: string };
    const acknowledged = JSON.parse(stored.snapshot)[symbol].acknowledgedEventKeys as string[];
    expect(acknowledged).toContain(`${symbol}:REF_DRAWDOWN:20`);

    const after = buildDigest({ userId: USER, watchlistId: wl, now: Date.now(), sensitivity: 0.8 });
    expect(after.cards).toEqual([]);
    expect(after.isQuiet).toBe(true);

    // Crossing a new 10% reference bucket is new information and may surface again.
    seedQuote(symbol, 120, { prevClose: 100, asOf: Date.now() + 60_000 });
    const changed = buildDigest({ userId: USER, watchlistId: wl, now: Date.now() + 120_000, sensitivity: 0.8 });
    expect(changed.cards[0]?.symbol).toBe(symbol);
    expect(changed.cards[0]?.events.some((e) => e.dedupKey === `${symbol}:REF_DRAWDOWN:50`)).toBe(true);
  });

  /**
   * VOLUME_SPIKE keeps ONE dedup key for the whole session, so it cannot signal "I got
   * bigger" the way REF_DRAWDOWN does by crossing a bucket. Without a last-updated
   * clock it would stay silent all session once acknowledged, no matter how far the
   * volume ran — and with a clock but no materiality guard it would reopen on every
   * poll, because volume is cumulative and rises on every tick.
   */
  it('reopens an acknowledged volume spike when it strengthens materially, and not otherwise', () => {
    const wl = 'vol-wl';
    const symbol = 'VOL.NS';
    const base = Date.now();
    db.prepare(`INSERT INTO watchlists (id,user_id,name,version,created_at) VALUES (?,?,?,1,?)`)
      .run(wl, USER, 'Volume', NOW);
    db.prepare(
      `INSERT INTO watchlist_items (watchlist_id,symbol,added_at,ref_price) VALUES (?,?,?,?)`,
    ).run(wl, symbol, NOW, 100);
    // Flat price against a 2% sigma and a ref price it never left: volume is the only
    // thing that can fire here, which keeps the assertions unambiguous.
    seedBars(symbol, 0.02);
    seedQuote(symbol, 100, { prevClose: 100, volume: 3000, asOf: base });
    db.prepare(
      `INSERT INTO checkpoints (id,user_id,watchlist_id,taken_at,snapshot) VALUES (?,?,?,?,?)`,
    ).run('vol-before', USER, wl, base - 60_000, JSON.stringify({ [symbol]: { price: 100 } }));

    const before = buildDigest({ userId: USER, watchlistId: wl, now: base + 1_000, sensitivity: 0.8 });
    expect(before.cards[0]?.events.map((e) => e.type)).toEqual(['VOLUME_SPIKE']);
    const spikeKey = before.cards[0]!.events[0]!.dedupKey;

    // Mark caught up at 3x — the condition is now acknowledged and must go quiet.
    writeCheckpoint(USER, wl);
    expect(buildDigest({ userId: USER, watchlistId: wl, now: base + 2_000, sensitivity: 0.8 }).cards).toEqual([]);

    // 3x -> 4x of average volume: a 33% gain in weight. Same dedup key, so the ONLY
    // thing that can earn it a second showing is last-updated beating the checkpoint.
    seedQuote(symbol, 100, { prevClose: 100, volume: 4000, asOf: base + 60_000 });
    const stronger = buildDigest({ userId: USER, watchlistId: wl, now: base + 61_000, sensitivity: 0.8 });
    expect(stronger.cards[0]?.events.map((e) => e.dedupKey)).toEqual([spikeKey]);
    expect(stronger.cards[0]?.events[0]?.magnitude).toBe(4);

    // Acknowledge 4x explicitly, then drift to 4.1x. The row records the newer ratio,
    // but an immaterial gain must not reopen a card the user just dismissed.
    db.prepare(
      `INSERT INTO checkpoints (id,user_id,watchlist_id,taken_at,snapshot) VALUES (?,?,?,?,?)`,
    ).run('vol-after', USER, wl, base + 90_000,
      JSON.stringify({ [symbol]: { price: 100, acknowledgedEventKeys: [spikeKey] } }));
    seedQuote(symbol, 100, { prevClose: 100, volume: 4100, asOf: base + 120_000 });
    const drift = buildDigest({ userId: USER, watchlistId: wl, now: base + 121_000, sensitivity: 0.8 });
    expect(drift.cards).toEqual([]);
    expect(drift.isQuiet).toBe(true);

    // 4.1x -> 6x is material again, so the card comes back — but QUIETER. It has been
    // shown in two prior visits this session, so novelty has damped it to 0.7^2. This is
    // the whole contract: a strengthening event resurfaces without shouting afresh.
    seedQuote(symbol, 100, { prevClose: 100, volume: 6000, asOf: base + 150_000 });
    const again = buildDigest({ userId: USER, watchlistId: wl, now: base + 151_000, sensitivity: 0.8 });
    expect(again.cards[0]?.events.map((e) => e.type)).toEqual(['VOLUME_SPIKE']);
    expect(again.cards[0]?.events[0]?.magnitude).toBe(6);
    expect(again.cards[0]?.events[0]?.noveltyFactor).toBeCloseTo(0.7 ** 2, 10);
    expect(again.cards[0]!.events[0]!.score).toBeLessThan(stronger.cards[0]!.events[0]!.baseScore);
  });
});
