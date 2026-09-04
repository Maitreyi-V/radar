import type { Quote } from '../ingestion/types.js';
import { mulberry32, gaussian, hashSeed } from './random.js';

/** NSE regular session: 09:15 -> 15:30 IST = 375 minutes. */
export const SESSION_MINUTES = 375;

export interface SynthParams {
  symbol: string;
  /** Previous close — the session opens by gapping from here. */
  prevClose: number;
  /** The stock's REAL 30-day daily-return sigma, measured from daily_bars. */
  dailySigma: number;
  /** Average daily volume, from daily_bars. */
  avgVolume: number;
  seed?: number;
  /** Drift over the whole session, as a fraction (0.01 = +1% expected). */
  drift?: number;
  /** Probability per session of a single large intraday jump (news shock). */
  jumpProb?: number;
  /** Gap between previous close and the open, in units of daily sigma. */
  gapSigmas?: number;
}

/**
 * Geometric Brownian Motion, calibrated per-stock on REAL measured volatility.
 *
 * Why GBM: prices are non-negative and returns compound, so we model log-returns.
 * Why per-stock sigma: the entire product thesis is that a 2% move means different
 * things for different stocks. If the simulator used one global sigma, replay would
 * "prove" the significance engine works while quietly assuming away the problem it solves.
 *
 * Volatility scales with sqrt(time), so per-minute sigma = dailySigma / sqrt(375).
 */
export function generateSession(p: SynthParams): Quote[] {
  const rand = mulberry32(p.seed ?? hashSeed(p.symbol));
  const perMinuteSigma = p.dailySigma / Math.sqrt(SESSION_MINUTES);

  const gapSigmas = p.gapSigmas ?? gaussian(rand) * 0.4;
  const open = p.prevClose * (1 + gapSigmas * p.dailySigma);

  // Optional single news-shock jump, placed at a random minute.
  const hasJump = rand() < (p.jumpProb ?? 0.15);
  const jumpAt = Math.floor(rand() * SESSION_MINUTES);
  const jumpSize = (rand() < 0.5 ? -1 : 1) * p.dailySigma * (2 + rand() * 2);

  const driftPerMinute = (p.drift ?? 0) / SESSION_MINUTES;

  const out: Quote[] = [];
  let price = open;
  let high = open, low = open, cumVolume = 0;

  for (let m = 0; m < SESSION_MINUTES; m++) {
    // log-return step: drift - variance correction + sigma * shock
    let logRet = driftPerMinute - 0.5 * perMinuteSigma ** 2 + perMinuteSigma * gaussian(rand);
    if (hasJump && m === jumpAt) logRet += jumpSize;
    price = price * Math.exp(logRet);

    high = Math.max(high, price);
    low = Math.min(low, price);

    // Volume is U-shaped across the day (heavy at open and close) and spikes on the jump.
    const u = m / (SESSION_MINUTES - 1);
    const shape = 0.6 + 1.8 * (Math.exp(-u * 6) + Math.exp(-(1 - u) * 6));
    const noise = 0.7 + rand() * 0.6;
    const jumpBoost = hasJump && Math.abs(m - jumpAt) < 15 ? 3 : 1;
    cumVolume += Math.max(0, Math.round((p.avgVolume / SESSION_MINUTES) * shape * noise * jumpBoost));

    out.push({
      symbol: p.symbol,
      price: round2(price),
      volume: cumVolume,
      dayHigh: round2(high),
      dayLow: round2(low),
      dayOpen: round2(open),
      prevClose: round2(p.prevClose),
      week52High: null,
      week52Low: null,
      asOf: 0,          // caller stamps the session clock
      fetchedAt: 0,
      source: 'synthetic',
      isSynthetic: true,
    });
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
