/** The single internal shape every provider adapter must normalise to. */
export interface Quote {
  symbol: string;
  price: number;
  volume: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayOpen: number | null;
  prevClose: number | null;
  week52High: number | null;
  week52Low: number | null;
  /** Exchange timestamp: when this price was true in the market. */
  asOf: number;
  /** When we received it. asOf !== fetchedAt is the staleness story. */
  fetchedAt: number;
  source: string;
  isSynthetic: boolean;
}

export interface DailyBar {
  symbol: string;
  date: string; // YYYY-MM-DD (IST)
  open: number | null; high: number | null; low: number | null;
  close: number; volume: number | null;
}

export interface ProviderAdapter {
  readonly name: string;
  fetchQuote(symbol: string): Promise<Quote>;
  /** Daily history powering sigma / 20d avg volume / 52w range. */
  fetchDailyBars?(symbol: string, days: number): Promise<DailyBar[]>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly provider: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}
