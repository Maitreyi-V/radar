import type { Bar } from './stats.js';

export type EventType =
  | 'VOLATILITY_MOVE' | 'VOLUME_SPIKE' | 'BREACH_52W'
  | 'GAP_OPEN' | 'STREAK' | 'REF_DRAWDOWN';

/** Everything a detector is allowed to see. No I/O, no clock, no globals. */
export interface SymbolContext {
  symbol: string;
  /** Daily history, oldest first, EXCLUDING today. */
  bars: Bar[];
  price: number;
  volume: number | null;
  dayOpen: number | null;
  prevClose: number | null;
  /** Provider-reported 52w range; falls back to computing from bars. */
  week52High: number | null;
  week52Low: number | null;
  /** Exchange time of the current price. */
  asOf: number;
  /** What the user last saw. Undefined for a first-ever visit. */
  checkpointPrice?: number;
  checkpointAt?: number;
  /** Price when the user ADDED the stock — powers the personal REF_DRAWDOWN signal. */
  refPrice?: number;
  /** IST session date of `asOf`, used to build stable dedup keys. */
  sessionDate: string;
}

export interface DetectedEvent {
  symbol: string;
  type: EventType;
  /** The raw signal size in its natural unit (sigmas, x-average, percent). */
  magnitude: number;
  /** Base weight before recency/novelty adjustment. */
  baseScore: number;
  occurredAt: number;
  /** The numbers behind the sentence — rendered in the UI, never hidden. */
  detail: Record<string, number | string | null>;
  dedupKey: string;
  /** Plain-English, with its numbers. No unexplained badges. */
  explanation: string;
}
