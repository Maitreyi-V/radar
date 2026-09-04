import path from 'node:path';

export const CONFIG = {
  port: Number(process.env.PORT ?? 4000),
  dbFile: process.env.RADAR_DB ?? path.resolve(process.cwd(), 'data/radar.db'),
  /** Poll cadence per symbol while the market is open. */
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),
  /** Max concurrent outbound provider requests (politeness + rate-limit safety). */
  fetchConcurrency: Number(process.env.FETCH_CONCURRENCY ?? 2),
  sessionTtlMs: 1000 * 60 * 60 * 24 * 30,
} as const;

/** Staleness contract thresholds (ms). Surfaced honestly in the UI. */
export const STALENESS = {
  live: 60_000,        // <= 60s  -> LIVE
  delayed: 900_000,    // <= 15m  -> DELAYED
} as const;
