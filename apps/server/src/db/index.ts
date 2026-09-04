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
