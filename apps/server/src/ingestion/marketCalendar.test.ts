import { describe, it, expect } from 'vitest';
import { isTradingDay, isMarketOpen, marketPhase, sessionDate, msUntilClose } from './marketCalendar.js';

/** Helper: an IST wall-clock instant expressed as epoch ms. */
const ist = (y: number, m: number, d: number, hh = 0, mm = 0): number =>
  Date.UTC(y, m - 1, d, hh, mm) - 5.5 * 3600_000;

describe('trading days', () => {
  it('accepts a normal weekday', () => {
    expect(isTradingDay(ist(2026, 9, 4, 12))).toBe(true);   // Friday
  });

  it('rejects the weekend — the reason this project needed a calendar at all', () => {
    expect(isTradingDay(ist(2026, 9, 5, 12))).toBe(false);  // Saturday
    expect(isTradingDay(ist(2026, 9, 6, 12))).toBe(false);  // Sunday
  });

  it('rejects a known NSE holiday', () => {
    expect(isTradingDay(ist(2026, 8, 15, 12))).toBe(false); // Independence Day
  });
});

describe('session hours (09:15–15:30 IST)', () => {
  it('is closed before the open and after the close', () => {
    expect(isMarketOpen(ist(2026, 9, 4, 9, 14))).toBe(false);
    expect(isMarketOpen(ist(2026, 9, 4, 15, 31))).toBe(false);
  });

  it('is open at the boundaries and mid-session', () => {
    expect(isMarketOpen(ist(2026, 9, 4, 9, 15))).toBe(true);
    expect(isMarketOpen(ist(2026, 9, 4, 12, 0))).toBe(true);
    expect(isMarketOpen(ist(2026, 9, 4, 15, 30))).toBe(true);
  });

  it('distinguishes the pre-open window', () => {
    expect(marketPhase(ist(2026, 9, 4, 9, 5))).toBe('PRE_OPEN');
    expect(marketPhase(ist(2026, 9, 4, 12, 0))).toBe('OPEN');
    expect(marketPhase(ist(2026, 9, 4, 16, 0))).toBe('CLOSED');
    expect(marketPhase(ist(2026, 9, 5, 12, 0))).toBe('CLOSED');
  });
});

describe('sessionDate', () => {
  it('uses the IST calendar date, not UTC', () => {
    // 2026-09-04 09:15 IST is still 2026-09-04 03:45 UTC — the date must not slip.
    expect(sessionDate(ist(2026, 9, 4, 9, 15))).toBe('2026-09-04');
    // 23:30 IST is the NEXT day in UTC; the session date must stay on the IST day.
    expect(sessionDate(ist(2026, 9, 4, 23, 30))).toBe('2026-09-04');
  });
});

describe('msUntilClose', () => {
  it('counts down during the session and is 0 when shut', () => {
    expect(msUntilClose(ist(2026, 9, 4, 15, 0))).toBe(30 * 60_000);
    expect(msUntilClose(ist(2026, 9, 5, 12, 0))).toBe(0);
  });
});
