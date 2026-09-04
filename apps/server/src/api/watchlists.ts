import { db, tx } from '../db/index.js';
import { newId } from './auth.js';
import { latestQuote } from '../ingestion/store.js';

/** Thrown when a write carries a stale `version` — surfaced to the client as 409. */
export class ConflictError extends Error {
  constructor(readonly current: { version: number; symbols: string[] }) {
    super('watchlist was modified by another session');
    this.name = 'ConflictError';
  }
}

export interface Watchlist { id: string; name: string; version: number; symbols: string[] }

export function listWatchlists(userId: string): Watchlist[] {
  const rows = db.prepare(
    `SELECT id, name, version FROM watchlists WHERE user_id = ? ORDER BY created_at ASC`,
  ).all(userId) as Array<{ id: string; name: string; version: number }>;
  return rows.map((r) => ({ ...r, symbols: symbolsOf(r.id) }));
}

export function symbolsOf(watchlistId: string): string[] {
  return (db.prepare(
    `SELECT symbol FROM watchlist_items WHERE watchlist_id = ? ORDER BY added_at ASC`,
  ).all(watchlistId) as Array<{ symbol: string }>).map((r) => r.symbol);
}

export function getWatchlist(userId: string, id: string): Watchlist | null {
  const row = db.prepare(
    `SELECT id, name, version FROM watchlists WHERE id = ? AND user_id = ?`,
  ).get(id, userId) as { id: string; name: string; version: number } | undefined;
  return row ? { ...row, symbols: symbolsOf(row.id) } : null;
}

export function createWatchlist(userId: string, name: string): Watchlist {
  const id = newId();
  db.prepare(`INSERT INTO watchlists (id, user_id, name, version, created_at) VALUES (?, ?, ?, 1, ?)`)
    .run(id, userId, name, Date.now());
  return { id, name, version: 1, symbols: [] };
}

/**
 * Add a symbol.
 *
 * Two properties worth noting:
 *  - Idempotent by DB constraint. A double-tap hits UNIQUE(watchlist_id, symbol) and is
 *    a no-op returning 200 with the existing row — never a 500, never a duplicate.
 *  - `ref_price` is stamped at add time from the latest known quote. That is what makes
 *    REF_DRAWDOWN personal: "down 12% since YOU added it", not since some market open.
 *
 * `expectedVersion` enables optimistic concurrency: pass the version you last read and
 * the write is rejected with 409 if someone else changed the list meanwhile.
 */
export function addSymbol(
  userId: string, watchlistId: string, symbol: string, expectedVersion?: number,
): Watchlist {
  return tx(() => {
    const wl = requireOwned(userId, watchlistId);
    assertVersion(wl, expectedVersion, watchlistId);

    const existing = db.prepare(
      `SELECT 1 FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?`,
    ).get(watchlistId, symbol);

    if (!existing) {
      const ref = latestQuote(symbol)?.price ?? null;
      db.prepare(
        `INSERT INTO watchlist_items (watchlist_id, symbol, added_at, ref_price)
         VALUES (?, ?, ?, ?) ON CONFLICT (watchlist_id, symbol) DO NOTHING`,
      ).run(watchlistId, symbol, Date.now(), ref);
      bumpVersion(watchlistId);
    }
    return getWatchlist(userId, watchlistId)!;
  });
}

export function removeSymbol(
  userId: string, watchlistId: string, symbol: string, expectedVersion?: number,
): Watchlist {
  return tx(() => {
    const wl = requireOwned(userId, watchlistId);
    assertVersion(wl, expectedVersion, watchlistId);
    const info = db.prepare(
      `DELETE FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?`,
    ).run(watchlistId, symbol);
    if (info.changes > 0) bumpVersion(watchlistId);
    return getWatchlist(userId, watchlistId)!;
  });
}

/**
 * Write a checkpoint: a snapshot of exactly what the user last saw.
 *
 * Taken inside ONE transaction so it cannot interleave with an in-flight quote write —
 * otherwise the snapshot could mix prices from two different instants and the digest
 * would report a change that never happened.
 */
export function writeCheckpoint(userId: string, watchlistId: string): { id: string; takenAt: number; symbols: number } {
  return tx(() => {
    requireOwned(userId, watchlistId);
    const symbols = symbolsOf(watchlistId);
    const snapshot: Record<string, { price: number; dayHigh: number | null; dayLow: number | null; volume: number | null; asOf: number }> = {};
    for (const s of symbols) {
      const q = latestQuote(s);
      if (q) snapshot[s] = { price: q.price, dayHigh: q.dayHigh, dayLow: q.dayLow, volume: q.volume, asOf: q.asOf };
    }
    const id = newId();
    const takenAt = Date.now();
    db.prepare(
      `INSERT INTO checkpoints (id, user_id, watchlist_id, taken_at, snapshot) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, userId, watchlistId, takenAt, JSON.stringify(snapshot));
    return { id, takenAt, symbols: Object.keys(snapshot).length };
  });
}

export function renameWatchlist(userId: string, id: string, name: string): Watchlist {
  requireOwned(userId, id);
  db.prepare(`UPDATE watchlists SET name = ?, version = version + 1 WHERE id = ?`).run(name, id);
  return getWatchlist(userId, id)!;
}

/** Deleting a watchlist cascades to its items and checkpoints via FK ON DELETE CASCADE. */
export function deleteWatchlist(userId: string, id: string): void {
  requireOwned(userId, id);
  db.prepare(`DELETE FROM watchlists WHERE id = ? AND user_id = ?`).run(id, userId);
}

/** Past visits — the "memory" made browsable. Newest first. */
export function checkpointHistory(userId: string, watchlistId: string, limit = 20): Array<{ id: string; takenAt: number; symbols: number }> {
  const rows = db.prepare(
    `SELECT id, taken_at AS takenAt, snapshot FROM checkpoints
     WHERE user_id = ? AND watchlist_id = ? ORDER BY taken_at DESC LIMIT ?`,
  ).all(userId, watchlistId, limit) as Array<{ id: string; takenAt: number; snapshot: string }>;
  return rows.map((r) => {
    let n = 0;
    try { n = Object.keys(JSON.parse(r.snapshot)).length; } catch { /* corrupt snapshot counts as 0 */ }
    return { id: r.id, takenAt: r.takenAt, symbols: n };
  });
}

function requireOwned(userId: string, watchlistId: string): { version: number } {
  const wl = db.prepare(
    `SELECT version FROM watchlists WHERE id = ? AND user_id = ?`,
  ).get(watchlistId, userId) as { version: number } | undefined;
  if (!wl) throw Object.assign(new Error('watchlist not found'), { statusCode: 404 });
  return wl;
}

function assertVersion(wl: { version: number }, expected: number | undefined, watchlistId: string): void {
  if (expected !== undefined && expected !== wl.version) {
    throw new ConflictError({ version: wl.version, symbols: symbolsOf(watchlistId) });
  }
}

function bumpVersion(watchlistId: string): void {
  db.prepare(`UPDATE watchlists SET version = version + 1 WHERE id = ?`).run(watchlistId);
}
