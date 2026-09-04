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
  db.prepare(
    `INSERT INTO quotes (symbol, price, volume, day_high, day_low, day_open, prev_close,
       week52_high, week52_low, as_of, fetched_at, source, is_synthetic, session_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'test',0,'2026-09-04')`,
  ).run(symbol, price, opts.volume ?? 1000, price, price, opts.prevClose ?? 100,
        opts.prevClose ?? 100, null, null, opts.asOf ?? NOW - 30_000, NOW);
}

beforeAll(async () => {
  ({ db } = await import('../db/index.js'));
  ({ buildDigest, freshnessOf } = await import('./build.js'));

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
});
