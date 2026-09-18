import type { ScoredEvent } from '../significance/score.js';

export type Freshness = 'LIVE' | 'DELAYED' | 'STALE' | 'MARKET_CLOSED' | 'RECORDED' | 'REPLAY';
export type DataMode = 'CURRENT' | 'RECORDED' | 'REPLAY';

export interface DigestCard {
  symbol: string;
  name: string;
  price: number;
  changePct: number | null;
  /** Every event we surfaced for this symbol, highest-scoring first. */
  events: ScoredEvent[];
  /** The single sentence shown on the card. */
  headline: string;
  /** Supporting sentences from the remaining events on the same symbol. */
  supporting: string[];
  score: number;
  freshness: Freshness;
  asOf: number;
}

export interface Digest {
  watchlistId: string;
  /** Whether this digest is based on current, recorded-demo, or actively replayed data. */
  dataMode: DataMode;
  /** Trading date behind recorded/replayed data. Null for the current feed. */
  dataSessionDate: string | null;
  /** The checkpoint this digest is measured against. Null on a first-ever visit. */
  since: number | null;
  sinceLabel: string;
  generatedAt: number;
  cards: DigestCard[];
  /** Count of watched symbols that produced nothing worth surfacing. */
  quietCount: number;
  quietSymbols: string[];
  /**
   * WHY each quiet symbol stayed quiet — its move, its own sigma, and the resulting
   * z-score. Surfacing the negative case is unusual and deliberate: "nothing happened"
   * is only trustworthy if you can see the arithmetic behind it.
   */
  quietDetail: Array<{
    symbol: string; name: string; price: number;
    changePct: number | null; sigmaPct: number | null; z: number | null;
    reason: string;
  }>;
  /** The attention threshold this digest was computed with. */
  sensitivity: number;
  /** True when nothing crossed the attention threshold — a deliberate, honest state. */
  isQuiet: boolean;
  marketPhase: 'OPEN' | 'PRE_OPEN' | 'CLOSED';
  /** Symbols we could not price at all (provider gaps) — surfaced, never hidden. */
  unavailable: string[];
  /** Symbols where two providers disagreed materially; the shown price is the incumbent. */
  unconfirmed: Array<{ symbol: string; reason: string }>;
}
