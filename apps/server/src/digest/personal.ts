import { db } from '../db/index.js';
import { quoteColumns, type SessionSummary, type Stream } from '../ingestion/projections.js';
import type { Quote } from '../ingestion/types.js';
import { detectRefDrawdown, detectVolatilityMove, short, THRESHOLDS } from '../significance/detectors.js';
import { volatility, type Bar } from '../significance/stats.js';
import type { DetectedEvent, SymbolContext } from '../significance/types.js';
import { recencyDecay } from '../significance/score.js';

/** Two personal detectors over session extrema, with bounded-to-a-session SQL refinements.
 * No quote arrays and no shared detector execution on the digest path.
 * Sigma is fixed to the history available BEFORE each session, matching ingestion.
 */
export function personalEvents(opts: {
  symbol: string; stream: Stream; after: number; until: number; latestAsOf: number;
  checkpointPrice?: number; refPrice?: number; acknowledged: Set<string>; sensitivity: number;
}): DetectedEvent[] {
  const { symbol, stream, after, until, acknowledged } = opts;
  const summaries = db.prepare(`SELECT stream, symbol, session_date, first_at, last_at,
      open_quote, high_quote, low_quote, latest_quote, max_volume FROM session_summaries
    WHERE stream = ? AND symbol = ? AND last_at > ? AND first_at <= ? ORDER BY first_at`)
    .all(stream, symbol, after, until) as Array<Omit<SessionSummary, 'bars'>>;
  const events: DetectedEvent[] = [];
  for (const s of summaries) {
    const end = Math.min(until, s.last_at);
    // Even the maximum possible personal score cannot survive ranking. Safe pruning,
    // not an arbitrary history cutoff; sensitivity=0 intentionally disables this.
    if (16 * recencyDecay(end, until) < opts.sensitivity) continue;
    const start = Math.max(after, s.first_at - 1);
    const partial = after >= s.first_at || until < s.last_at;
    const quotes: Quote[] = partial
      ? ['DESC', 'ASC'].flatMap((order) => {
        const row = db.prepare(`SELECT ${quoteColumns} FROM quotes WHERE symbol = ?
          AND (source = 'replay') = ? AND as_of > ? AND as_of <= ?
          ORDER BY price ${order}, as_of, id LIMIT 1`).get(symbol, stream === 'replay' ? 1 : 0, start, end) as Quote | undefined;
        return row ? [row] : [];
      })
      : [JSON.parse(s.high_quote), JSON.parse(s.low_quote)];
    const baseline = db.prepare(`SELECT bars FROM session_summaries
      WHERE stream = ? AND symbol = ? AND session_date = ?`).get(stream, symbol, s.session_date) as { bars: string };
    const bars: Bar[] = JSON.parse(baseline.bars);
    const sigma = volatility(bars, 30);
    const candidates = new Map<string, { event: DetectedEvent; quote: Quote }>();
    for (const q of quotes) {
      const ctx: SymbolContext = { ...q, bars, sessionDate: s.session_date,
        checkpointPrice: opts.checkpointPrice, refPrice: opts.refPrice };
      for (const event of [detectVolatilityMove(ctx), detectRefDrawdown(ctx)]) {
        if (!event || acknowledged.has(event.dedupKey)) continue;
        const key = `${event.type}:${Math.sign(event.magnitude)}`;
        const current = candidates.get(key);
        if (!current || Math.abs(event.magnitude) > Math.abs(current.event.magnitude)) candidates.set(key, { event, quote: q });
      }
    }
    for (const { event, quote } of candidates.values()) {
      const sign = Math.sign(event.magnitude);
      const isMove = event.type === 'VOLATILITY_MOVE';
      const base = isMove ? opts.checkpointPrice ?? quote.prevClose : opts.refPrice;
      if (!base) continue;
      let threshold = isMove ? THRESHOLDS.volatilityZ : THRESHOLDS.refDrawdownPct;
      if (!isMove) {
        // Acknowledged +10% does not hide a new +20%, nor date it at the old +10%.
        while (acknowledged.has(`${symbol}:REF_DRAWDOWN:${sign * threshold}`)) threshold += 10;
      }
      // The predicate uses the same arithmetic as the detector (avoids boundary drift).
      const expression = isMove ? '((price - ?) / ?) / ?' : '((price - ?) / ?) * ?';
      const first = db.prepare(`SELECT as_of AS asOf FROM quotes WHERE symbol = ?
        AND (source = 'replay') = ? AND as_of > ? AND as_of <= ?
        AND (${expression}) * ? >= ? ORDER BY as_of, id LIMIT 1`)
        .get(symbol, stream === 'replay' ? 1 : 0, start, end, base, base, isMove ? sigma : 100, sign, threshold) as { asOf: number } | undefined;
      if (!first) continue;
      const peakAt = event.occurredAt;
      const change = Number(event.detail.changePct);
      const explanation = peakAt < opts.latestAsOf
        ? isMove
          ? `${short(symbol)} ${change >= 0 ? 'rose' : 'fell'} as much as ${Math.abs(change)}% since you left — ` +
            `${Math.abs(Number(event.detail.z))}× its usual daily move of about ±${event.detail.sigmaPct}%.`
          : `${short(symbol)} was ${change >= 0 ? 'up' : 'down'} as much as ${Math.abs(change)}% since you added it at ₹${event.detail.refPrice}.`
        : event.explanation;
      events.push({ ...event, occurredAt: first.asOf, explanation,
        detail: { ...event.detail, firstDetectedAt: first.asOf, peakAt } });
    }
  }
  return events;
}
