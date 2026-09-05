import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';
import { applyColumnMigrations } from './migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(CONFIG.dbFile), { recursive: true });

export const db = new Database(CONFIG.dbFile);
db.pragma('journal_mode = WAL');   // concurrent readers while the scheduler writes
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * Memoise prepared statements by SQL text.
 *
 * better-sqlite3 expects statements to be prepared once and reused. Preparing inside a
 * request handler creates a fresh native Statement per call, and once enough of them
 * become garbage their destructors run during teardown — which crashed the process hard:
 *
 *   node[1]: void node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
 *   Assertion failed: (env) != nullptr        -> exit 133
 *
 * Reproduced reliably by starting a replay, which drives thousands of statement creations
 * a second. Rather than hand-edit ~30 call sites (and rely on remembering the rule
 * forever), the cache is installed once here so every caller gets reuse for free. It is
 * also simply faster: SQLite reparses nothing.
 *
 * Safe because nothing in this codebase mutates statement state (`.pluck()`, `.raw()`,
 * `.bind()`), which would otherwise leak between callers sharing an instance.
 */
const rawPrepare = db.prepare.bind(db);
const statementCache = new Map<string, ReturnType<typeof rawPrepare>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(db as any).prepare = (sql: string) => {
  let cached = statementCache.get(sql);
  if (cached === undefined) {
    cached = rawPrepare(sql);
    statementCache.set(sql, cached);
  }
  return cached;
};

export function preparedStatementCount(): number { return statementCache.size; }

export function migrate(): void {
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
}

// Migrate at open time, NOT from an entrypoint.
// Reason: modules like store.ts prepare their statements at import time, and ESM runs
// every import before the importer's body. Calling migrate() from main() is therefore
// always too late. The schema is CREATE TABLE IF NOT EXISTS throughout, so this is
// idempotent and costs ~1ms.
migrate();
applyColumnMigrations(db);   // static import: migrate.ts must NOT import db back (circular)

/** Run fn inside a single transaction — used where a consistent read matters (checkpoints). */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn)();
}
