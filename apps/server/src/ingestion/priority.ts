/**
 * What we spend a scarce request budget on.
 *
 * Insight that drives this: daily bars are HISTORICAL — they can be fetched on Saturday
 * or Sunday when nothing competes for the budget. Live intraday ticks exist only while
 * the market is open and can never be recovered. So during market hours, 100% of the
 * budget goes to live quotes; backfill is deferred to the weekend.
 *
 * The demo watchlist is polled first and most often, because those are the symbols the
 * hero moment is built on.
 */
export const DEMO_WATCHLIST = [
  'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'TATAMOTORS.NS',
  'SBIN.NS', 'ITC.NS', 'BHARTIARTL.NS', 'ICICIBANK.NS',
  // Deliberately volatile small/mid caps — these are what prove that a z-score
  // separates "genuine event" from "normal noise for this stock".
  'SUZLON.NS', 'IDEA.NS', 'YESBANK.NS', 'PAYTM.NS', 'IRCTC.NS', 'BEL.NS',
] as const;

export const DEMO_SET = new Set<string>(DEMO_WATCHLIST);

/** Demo symbols first (in order), then everything else. */
export function prioritise(all: string[]): string[] {
  const rest = all.filter((s) => !DEMO_SET.has(s));
  return [...DEMO_WATCHLIST.filter((s) => all.includes(s)), ...rest];
}
