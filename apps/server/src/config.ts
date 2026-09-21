// ═══════════════════════════════════════════════════════════════════════════
// config.ts — every tunable number in Radar, in one place.
//
// WHY THIS FILE EXISTS: if a threshold is hardcoded in five files, changing it
// means finding five files. Here there is exactly one place to look and change.
// ═══════════════════════════════════════════════════════════════════════════

// 'node:path' is Node's built-in file-path helper (like Python's os.path).
// The 'node:' prefix says "this is built into Node, not a package I installed".
// No { } braces  ->  we are importing the module's DEFAULT export.
import path from 'node:path';

/**
 * CONFIG — runtime settings.
 *
 * Every value follows the same pattern:
 *     process.env.SOMETHING  ??  <sensible default>
 *
 * process.env = the environment variables of the machine (Python: os.environ).
 * ??          = "use the left side, unless it is null/undefined, then use the right".
 *
 * WHY: the same code must run on my laptop AND on Render (the host) without
 * editing a single line. The host sets PORT; my laptop doesn't, so it gets 4000.
 */
export const CONFIG = {
  // Number(...) converts the text "4000" into the number 4000.
  // Env vars are ALWAYS strings, so this conversion is mandatory.
  port: Number(process.env.PORT ?? 4000),

  // process.cwd() = "current working directory" — where the app was started from.
  // path.resolve turns that into one absolute path like /Users/.../data/radar.db
  dbFile: process.env.RADAR_DB ?? path.resolve(process.cwd(), 'data/radar.db'),

  /** Poll cadence per symbol while the market is open. */
  // 30_000 is just 30000. The underscore is a readability separator (like 1_00_000).
  // 30 seconds is the deliberate trade-off: fresh enough to feel live, slow enough
  // that the free data providers don't rate-limit or ban us.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),

  /** Max concurrent outbound provider requests (politeness + rate-limit safety). */
  fetchConcurrency: Number(process.env.FETCH_CONCURRENCY ?? 2),

  // How long a login stays valid: 30 days.
  // Written as multiplication instead of 2592000000 so a reader can VERIFY it
  // at a glance:  1000ms x 60s x 60min x 24h x 30days.
  sessionTtlMs: 1000 * 60 * 60 * 24 * 30,
} as const;
// 'as const' tells TypeScript: "this object is frozen — nobody may reassign
// CONFIG.port at runtime". Without it, TS treats port as a plain mutable number.
// Java equivalent: marking every field 'final'.

/** Staleness contract thresholds (ms). Surfaced honestly in the UI. */
/**
 * These two numbers ARE the freshness labels from Appendix A6 of the deck.
 *
 *   age <= 60s        -> LIVE
 *   60s < age <= 15m  -> DELAYED
 *   age > 15m         -> STALE
 *
 * Note there is no "STALE" number here — STALE is simply "neither of the above".
 * Defining only the boundaries means the three states can never overlap or
 * leave a gap, which is exactly the kind of bug a finance UI cannot afford.
 */
export const STALENESS = {
  live: 60_000,        // <= 60s  -> LIVE
  delayed: 900_000,    // <= 15m  -> DELAYED
} as const;
