/**
 * NSE trading calendar, in IST. Everything anchors to trading SESSIONS, not wall-clock —
 * that is what makes "since Friday's close" correct over a weekend instead of
 * reporting a nonsensical "0% change over 65 hours".
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const OPEN_MIN = 9 * 60 + 15;    // 09:15 IST
const CLOSE_MIN = 15 * 60 + 30;  // 15:30 IST

/** Wall-clock fields of `ms` as seen in IST. */
function ist(ms: number) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate(),
    weekday: d.getUTCDay(),                       // 0 Sun .. 6 Sat
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** IST trading date as 'YYYY-MM-DD'. */
export function sessionDate(ms: number = Date.now()): string {
  const { y, m, day } = ist(ms);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** NSE holidays 2026 (trading holidays; extend as needed). */
const HOLIDAYS = new Set<string>([
  '2026-01-26', '2026-03-04', '2026-03-25', '2026-04-01', '2026-04-03',
  '2026-05-01', '2026-08-15', '2026-10-02', '2026-11-10', '2026-12-25',
]);

export function isTradingDay(ms: number = Date.now()): boolean {
  const { weekday } = ist(ms);
  if (weekday === 0 || weekday === 6) return false;
  return !HOLIDAYS.has(sessionDate(ms));
}

export function isMarketOpen(ms: number = Date.now()): boolean {
  if (!isTradingDay(ms)) return false;
  const { minutes } = ist(ms);
  return minutes >= OPEN_MIN && minutes <= CLOSE_MIN;
}

export type MarketPhase = 'OPEN' | 'PRE_OPEN' | 'CLOSED';

export function marketPhase(ms: number = Date.now()): MarketPhase {
  if (!isTradingDay(ms)) return 'CLOSED';
  const { minutes } = ist(ms);
  if (minutes >= OPEN_MIN && minutes <= CLOSE_MIN) return 'OPEN';
  if (minutes >= 9 * 60 && minutes < OPEN_MIN) return 'PRE_OPEN';
  return 'CLOSED';
}

/** Epoch ms of the most recent session close at or before `ms`. The digest anchor. */
export function lastSessionClose(ms: number = Date.now()): number {
  let cursor = ms;
  for (let i = 0; i < 15; i++) {
    if (isTradingDay(cursor)) {
      const { minutes } = ist(cursor);
      if (minutes > CLOSE_MIN || i > 0) {
        const base = cursor - ((minutes - CLOSE_MIN) * 60_000);
        if (base <= ms) return base;
      }
    }
    cursor -= 24 * 60 * 60 * 1000;
  }
  return ms;
}

export function msUntilClose(ms: number = Date.now()): number {
  if (!isMarketOpen(ms)) return 0;
  return (CLOSE_MIN - ist(ms).minutes) * 60_000;
}
