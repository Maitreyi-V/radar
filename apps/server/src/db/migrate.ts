import type DatabaseType from 'better-sqlite3';

/**
 * Additive column migrations for databases created by an earlier schema version.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so we consult PRAGMA table_info first.
 *
 * Takes the Database instance as an ARGUMENT rather than importing it from db/index.
 * Importing would be circular — index.ts calls this during its own initialisation, so
 * the import would wait on a module that is waiting on us, and deadlock.
 *
 * Additive-only on purpose: a database holding real recorded ticks must never be
 * dropped to apply a schema change.
 */
const COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'symbols', column: 'bse_code', ddl: 'ALTER TABLE symbols ADD COLUMN bse_code TEXT' },
  { table: 'symbols', column: 'mktcap', ddl: 'ALTER TABLE symbols ADD COLUMN mktcap REAL' },
  { table: 'symbols', column: 'tracked', ddl: 'ALTER TABLE symbols ADD COLUMN tracked INTEGER NOT NULL DEFAULT 0' },
];

export function applyColumnMigrations(db: DatabaseType.Database): string[] {
  const applied: string[] = [];
  for (const { table, column, ddl } of COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.length === 0) continue;
    if (cols.some((c) => c.name === column)) continue;
    db.exec(ddl);
    applied.push(`${table}.${column}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_symbols_bse ON symbols(bse_code)`);
  return applied;
}
