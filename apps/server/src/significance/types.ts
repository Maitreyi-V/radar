import type { Bar } from './stats.js';

// A union of string literals — the ONLY six values EventType can hold. Coming from Java
// this is the closest thing to an enum, except it's checked at compile time and compiles
// away to plain strings. Typo 'VOLUME_SPKE' anywhere and the build fails immediately.
export type EventType =
  | 'VOLATILITY_MOVE' | 'VOLUME_SPIKE' | 'BREACH_52W'
  | 'GAP_OPEN' | 'STREAK' | 'REF_DRAWDOWN';

/** Everything a detector is allowed to see. No I/O, no clock, no globals. */
// This interface is the contract that makes the engine testable. Because a detector can
// only read this object — no database, no Date.now() — every test is just "here's a shape,
// here's the expected event", and the same input always gives the same output.
export interface SymbolContext {
  symbol: string;
  /** Daily history, oldest first, EXCLUDING today. */
  // Excluding today matters: today's half-formed move must not be folded into the baseline
  // we're comparing today against, or a big move would partly normalise away its own sigma.
  bars: Bar[];
  price: number;
  // `number | null` = the value is either a number or explicitly null. Null here means
  // "the provider genuinely didn't give us this", which is different from zero.
  volume: number | null;
  dayOpen: number | null;
  prevClose: number | null;
  /** Provider-reported 52w range; falls back to computing from bars. */
  week52High: number | null;
  week52Low: number | null;
  /** Exchange time of the current price. */
  // Exchange time, not server time — the whole recency model counts trading time, so the
  // clock that matters is the market's.
  asOf: number;
  /** What the user last saw. Undefined for a first-ever visit. */
  // `?:` makes these optional — they may be absent from the object entirely. Absent is the
  // honest state for a first visit, and it's meaningfully different from `null`.
  checkpointPrice?: number;
  checkpointAt?: number;
  /** Price when the user ADDED the stock — powers the personal REF_DRAWDOWN signal. */
  refPrice?: number;
  /** IST session date of `asOf`, used to build stable dedup keys. */
  // Stored as a string date rather than a timestamp so two events in the same session
  // produce byte-identical dedup keys regardless of the time of day they fired.
  sessionDate: string;
}

// The one shape every detector returns. Uniform output is what lets the scoring layer rank
// six different kinds of signal against each other without knowing what any of them mean.
export interface DetectedEvent {
  symbol: string;
  type: EventType;
  /** The raw signal size in its natural unit (sigmas, x-average, percent). */
  // Kept in its own natural unit on purpose — this is the number for display and audit.
  // The comparable, cross-detector number is baseScore.
  magnitude: number;
  /** Base weight before recency/novelty adjustment. */
  baseScore: number;
  occurredAt: number;
  /** The numbers behind the sentence — rendered in the UI, never hidden. */
  // Record<K, V> is a map type: string keys to values of that union type. Loose on purpose,
  // since each detector has different numbers to show, and it all ends up on screen anyway.
  detail: Record<string, number | string | null>;
  dedupKey: string;
  /** Plain-English, with its numbers. No unexplained badges. */
  // Built by the detector, not the UI, because only the detector knows which numbers
  // actually drove the decision. This is what keeps the product explainable end to end.
  explanation: string;
}
