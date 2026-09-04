-- Pulse schema. Written to be Postgres-portable: no SQLite-only types,
-- INTEGER epoch-millis timestamps, TEXT for JSON payloads (JSONB in PG).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  pw_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlists (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- Optimistic concurrency: every mutation bumps this. Stale writes get 409.
  version    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);

CREATE TABLE IF NOT EXISTS watchlist_items (
  watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  added_at     INTEGER NOT NULL,
  -- price at the moment the user added it -> powers REF_DRAWDOWN ("since you added")
  ref_price    REAL,
  PRIMARY KEY (watchlist_id, symbol)   -- makes add-symbol idempotent at the DB level
);

-- Append-only quote history. as_of != fetched_at is the whole staleness story.
CREATE TABLE IF NOT EXISTS quotes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol       TEXT NOT NULL,
  price        REAL NOT NULL,
  volume       INTEGER,
  day_high     REAL,
  day_low      REAL,
  day_open     REAL,
  prev_close   REAL,
  week52_high  REAL,
  week52_low   REAL,
  as_of        INTEGER NOT NULL,   -- exchange timestamp reported by the provider
  fetched_at   INTEGER NOT NULL,   -- when WE received it
  source       TEXT NOT NULL,      -- yahoo | synthetic | replay | cache
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  session_date TEXT,               -- IST trading date 'YYYY-MM-DD', for replay slicing
  UNIQUE (symbol, as_of, source)   -- idempotent re-ingest of the same tick
);
CREATE INDEX IF NOT EXISTS idx_quotes_symbol_asof ON quotes(symbol, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_session ON quotes(session_date, as_of);

-- Daily bars: the statistical base for z-scores (30d sigma, 20d avg volume, 52w range).
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol     TEXT NOT NULL,
  bar_date   TEXT NOT NULL,   -- 'YYYY-MM-DD' IST
  open       REAL, high REAL, low REAL, close REAL NOT NULL, volume INTEGER,
  PRIMARY KEY (symbol, bar_date)
);

-- The diff anchor: a snapshot of exactly what the user last saw.
CREATE TABLE IF NOT EXISTS checkpoints (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  taken_at     INTEGER NOT NULL,
  snapshot     TEXT NOT NULL     -- JSON {symbol: {price, day_high, day_low, volume, as_of}}
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_lookup ON checkpoints(user_id, watchlist_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  type        TEXT NOT NULL,
  magnitude   REAL NOT NULL,
  score       REAL NOT NULL,
  occurred_at INTEGER NOT NULL,
  detail      TEXT NOT NULL,               -- JSON: the numbers behind the explanation
  dedup_key   TEXT NOT NULL UNIQUE         -- 'TCS:BREACH_52W:2026-09-04' -> can never fire twice
);
CREATE INDEX IF NOT EXISTS idx_events_symbol_time ON events(symbol, occurred_at DESC);

CREATE TABLE IF NOT EXISTS symbols (
  symbol    TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  exchange  TEXT NOT NULL DEFAULT 'NSE',
  bse_code  TEXT,          -- BSE scripcode; the BSE adapter needs it to fetch a quote
  mktcap    REAL           -- from the BSE scrip master, in INR crore
);
