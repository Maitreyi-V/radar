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
});

/** A watchlist of its own, so one test's symbols can't rank against another's. */
function isolatedWatchlist(id: string, symbols: string[], refPrice: number | null = null): void {
  db.prepare(`INSERT INTO watchlists (id,user_id,name,version,created_at) VALUES (?,?,?,1,?)`)
    .run(id, USER, id, CHECKPOINT);
  for (const symbol of symbols) {
    db.prepare(`INSERT INTO watchlist_items (watchlist_id,symbol,added_at,ref_price) VALUES (?,?,?,?)`)
      .run(id, symbol, CHECKPOINT, refPrice);
  }
  db.prepare(`INSERT INTO checkpoints (id,user_id,watchlist_id,taken_at,snapshot) VALUES (?,?,?,?,?)`)
    .run(`${id}-cp`, USER, id, CHECKPOINT,
      JSON.stringify(Object.fromEntries(symbols.map((s) => [s, { price: 100 }]))));
}

describe('quiet explanations', () => {
  /**
   * The bug this guards: the quiet row's verdict was computed purely from the PRICE
   * z-score, so a stock that traded 2.6x its normal volume on a dead-flat tape was
   * reported as "a quiet day for this stock". True about the price, false about the day.
   */
  it('names a suppressed non-price signal instead of giving a price verdict', () => {
    seedBars('VOLQ.NS', 0.02);                         // sigma ~4%/day, 1000 shares a day
    seedQuote('VOLQ.NS', 100, { prevClose: 100, volume: 2600 });   // flat price, 2.6x volume
    isolatedWatchlist('volq-wl', ['VOLQ.NS']);

    // baseScore for a 2.6x spike is ~3.12, so a sensitivity of 5 holds it back.
    const d = buildDigest({ userId: USER, watchlistId: 'volq-wl', now: NOW, sensitivity: 5 });
    expect(d.cards).toEqual([]);
    const row = d.quietDetail.find((q) => q.symbol === 'VOLQ.NS')!;

    expect(row.suppressed?.type).toBe('VOLUME_SPIKE');
    expect(row.reason).toMatch(/as many shares as it normally does/);
    expect(row.reason).toMatch(/below your attention threshold/);
    expect(row.reason).not.toMatch(/quiet day/);
    // The arithmetic is still there — this adds a field, it doesn't replace the numbers.
    expect(row.changePct).toBe(0);
    expect(row.sigmaPct).not.toBeNull();
  });

  it('still gives the plain price verdict when the stock was genuinely quiet', () => {
    seedBars('QUIETQ.NS', 0.02);                       // sigma ~4%/day
    seedQuote('QUIETQ.NS', 100.5, { prevClose: 100 }); // +0.5% = 0.125 sigma, ordinary volume
    isolatedWatchlist('quietq-wl', ['QUIETQ.NS']);

    const d = buildDigest({ userId: USER, watchlistId: 'quietq-wl', now: NOW });
    const row = d.quietDetail.find((q) => q.symbol === 'QUIETQ.NS')!;

    expect(row.suppressed).toBeUndefined();
    expect(row.reason).toBe('a quiet day for this stock');
  });

  it('explains a card that lost the attention budget rather than just counting it', () => {
    for (const [symbol, price] of [['OVA.NS', 106], ['OVB.NS', 112]] as const) {
      seedBars(symbol, 0.005);                         // sigma ~1%/day
      seedQuote(symbol, price, { prevClose: 100 });
    }
    isolatedWatchlist('overflow-wl', ['OVA.NS', 'OVB.NS']);

    // Both clear the threshold; a budget of one card forces the weaker into the quiet list.
    const d = buildDigest({ userId: USER, watchlistId: 'overflow-wl', now: NOW, limit: 1 });
    expect(d.cards.map((c) => c.symbol)).toEqual(['OVB.NS']);
    expect(d.quietSymbols).toEqual(['OVA.NS']);

    const row = d.quietDetail.find((q) => q.symbol === 'OVA.NS')!;
    expect(row.suppressed?.type).toBe('VOLATILITY_MOVE');
    expect(row.reason).toMatch(/ranked below the top 1$/);
    expect(row.changePct).toBe(6);
  });
});
