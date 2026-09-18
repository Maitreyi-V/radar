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
// Why these two detectors live here instead of in projections.ts: both are measured against
// something only THIS user has — the price when they last looked, and the price they bought
// at. Two people watching the same stock get different answers, so there's nothing to
// precompute once for everybody. Everything else was already projected at ingestion time.
export function personalEvents(opts: {
  // A single options object rather than nine positional arguments: at a call site
  // `refPrice: 1200` is self-describing where the ninth argument would not be.
  symbol: string; stream: Stream; after: number; until: number; latestAsOf: number;
  checkpointPrice?: number; refPrice?: number; acknowledged: Set<string>; sensitivity: number;
}): DetectedEvent[] {
  const { symbol, stream, after, until, acknowledged } = opts;   // destructuring: pull out the hot fields
  // Pull the pre-folded session summaries that overlap the window, NOT the raw ticks. This is
  // the performance decision of the whole digest path: a week away is a handful of summary
  // rows instead of tens of thousands of quotes.
  // `Omit<SessionSummary, 'bars'>` = that type minus the bars field, because the SELECT
  // deliberately doesn't fetch the (large) frozen baseline JSON until it's actually needed.
  const summaries = db.prepare(`SELECT stream, symbol, session_date, first_at, last_at,
      open_quote, high_quote, low_quote, latest_quote, max_volume FROM session_summaries
    WHERE stream = ? AND symbol = ? AND last_at > ? AND first_at <= ? ORDER BY first_at`)
    .all(stream, symbol, after, until) as Array<Omit<SessionSummary, 'bars'>>;
  const events: DetectedEvent[] = [];
  for (const s of summaries) {
    const end = Math.min(until, s.last_at);   // clip the session to the window we care about
    // Even the maximum possible personal score cannot survive ranking. Safe pruning,
    // not an arbitrary history cutoff; sensitivity=0 intentionally disables this.
    // 16 is the ceiling a personal event can reach (clamp of 8 × the ×2.0 weight), so if even
    // that, after decay, lands under the threshold, no amount of work here changes the output.
    if (16 * recencyDecay(end, until) < opts.sensitivity) continue;
    const start = Math.max(after, s.first_at - 1);   // -1 because the SQL below uses `as_of > start`
    // "Partial" = the window cuts into this session, so the day's stored high/low may sit
    // outside it. In that case we must find the extremes within the window instead.
    const partial = after >= s.first_at || until < s.last_at;
    const quotes: Quote[] = partial
      // Two one-row queries — highest price, then lowest — rather than loading the range and
      // scanning it. SQLite does the work through an index; we never hold the ticks in memory.
      ? ['DESC', 'ASC'].flatMap((order) => {
        const row = db.prepare(`SELECT ${quoteColumns} FROM quotes WHERE symbol = ?
          AND (source = 'replay') = ? AND as_of > ? AND as_of <= ?
          ORDER BY price ${order}, as_of, id LIMIT 1`).get(symbol, stream === 'replay' ? 1 : 0, start, end) as Quote | undefined;
        return row ? [row] : [];    // flatMap + [] drops the row cleanly when the window is empty
      })
      // Whole session inside the window -> the extremes we already folded at ingestion are
      // exactly right, and cost nothing to read.
      : [JSON.parse(s.high_quote), JSON.parse(s.low_quote)];
    // Same frozen baseline the ingestion path used for this session. Re-deriving sigma from
    // today's bars table would give a different answer than the one live users saw, and the
    // replay demo would no longer reproduce what actually happened.
    const baseline = db.prepare(`SELECT bars FROM session_summaries
      WHERE stream = ? AND symbol = ? AND session_date = ?`).get(stream, symbol, s.session_date) as { bars: string };
    const bars: Bar[] = JSON.parse(baseline.bars);
    const sigma = volatility(bars, 30);
    // Keyed on type AND sign so an up-move and a down-move in the same session both survive;
    // within each of those we keep only the most extreme one, since "it fell 4%" and "it fell
    // 3.8%" are the same story told twice.
    const candidates = new Map<string, { event: DetectedEvent; quote: Quote }>();
    for (const q of quotes) {
      // The extreme quote supplies the market side of the context; opts supplies the personal
      // side. This is the join between "what the stock did" and "what this user had seen".
      const ctx: SymbolContext = { ...q, bars, sessionDate: s.session_date,
        checkpointPrice: opts.checkpointPrice, refPrice: opts.refPrice };
      for (const event of [detectVolatilityMove(ctx), detectRefDrawdown(ctx)]) {
        // Skip nulls, and skip anything the user has explicitly dismissed already.
        if (!event || acknowledged.has(event.dedupKey)) continue;
        const key = `${event.type}:${Math.sign(event.magnitude)}`;
        const current = candidates.get(key);
        if (!current || Math.abs(event.magnitude) > Math.abs(current.event.magnitude)) candidates.set(key, { event, quote: q });
      }
    }
    for (const { event, quote } of candidates.values()) {
      const sign = Math.sign(event.magnitude);
      const isMove = event.type === 'VOLATILITY_MOVE';
      // Which price this event is measured from — checkpoint (or yesterday's close) for a
      // move, the user's entry price for a drawdown. Must match what the detector used.
      const base = isMove ? opts.checkpointPrice ?? quote.prevClose : opts.refPrice;
      if (!base) continue;   // EDGE CASE: no baseline to measure from -> drop rather than guess
      let threshold = isMove ? THRESHOLDS.volatilityZ : THRESHOLDS.refDrawdownPct;
      if (!isMove) {
        // Acknowledged +10% does not hide a new +20%, nor date it at the old +10%.
        // Walk up through the 10% bands the user has already dismissed, so we time the event
        // from where the NEW information began, not from the old band they've seen.
        while (acknowledged.has(`${symbol}:REF_DRAWDOWN:${sign * threshold}`)) threshold += 10;
      }
      // The predicate uses the same arithmetic as the detector (avoids boundary drift).
      // Written as SQL so the database finds the first crossing directly. The two branches
      // mirror the detectors exactly: divide by sigma for a z-score, ×100 for a percent.
      const expression = isMove ? '((price - ?) / ?) / ?' : '((price - ?) / ?) * ?';
      // Now the key question this whole block exists to answer: WHEN did this first become
      // true? The extreme tick tells us how big it got; this tells us when it started. We
      // date the event from the crossing so recency decay measures from the real beginning,
      // not from the incidental moment the stock happened to peak.
      // `* ? >= ?` with sign folded in handles both directions in one query — for a fall,
      // multiplying by -1 turns "at most -1.5" into "at least 1.5".
      const first = db.prepare(`SELECT as_of AS asOf FROM quotes WHERE symbol = ?
        AND (source = 'replay') = ? AND as_of > ? AND as_of <= ?
        AND (${expression}) * ? >= ? ORDER BY as_of, id LIMIT 1`)
        .get(symbol, stream === 'replay' ? 1 : 0, start, end, base, base, isMove ? sigma : 100, sign, threshold) as { asOf: number } | undefined;
      if (!first) continue;   // EDGE CASE: threshold never crossed in-window (all bands acknowledged)
      const peakAt = event.occurredAt;
      const change = Number(event.detail.changePct);
      // If the peak is in the past, the honest phrasing is "as much as X%" — the stock has
      // since come back, and saying a bare "fell 4%" about a number that now reads -1% is
      // the kind of small lie that makes a user stop trusting the whole product.
      const explanation = peakAt < opts.latestAsOf
        ? isMove
          ? `${short(symbol)} ${change >= 0 ? 'rose' : 'fell'} as much as ${Math.abs(change)}% since you left — ` +
            `${Math.abs(Number(event.detail.z))}× its usual daily move of about ±${event.detail.sigmaPct}%.`
          : `${short(symbol)} was ${change >= 0 ? 'up' : 'down'} as much as ${Math.abs(change)}% since you added it at ₹${event.detail.refPrice}.`
        : event.explanation;   // still at its peak right now -> the detector's present-tense sentence
      // Size from the peak, timing from the first crossing, both timestamps kept in detail so
      // the UI can show the full story and anyone can audit it.
      events.push({ ...event, occurredAt: first.asOf, explanation,
        detail: { ...event.detail, firstDetectedAt: first.asOf, peakAt } });
    }
  }
  return events;
}
