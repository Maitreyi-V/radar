/**
 * AIMD adaptive pacing — Additive Increase, Multiplicative Decrease.
 *
 * The same control law TCP congestion control uses, for the same reason: the server's
 * real limit is unknown, undocumented, and changes over time, so probe for it instead
 * of hardcoding a guess.
 *
 * Measured against Yahoo v8 on 2026-09-04:
 *   - burst capacity ~5 requests, refill ~1/minute
 *   - the penalty ESCALATES: 429 responses themselves extend the lockout, so a client
 *     that keeps polling through 429s never recovers
 * That last property is why decrease must be multiplicative and aggressive: backing off
 * hard is the only way out of the penalty box, and being greedy is self-defeating.
 *
 *   success -> interval -= step        (creep faster, gently)
 *   429     -> interval *= 2           (retreat fast, and stop asking)
 */
export class AdaptiveRate {
  private intervalMs: number;
  private consecutiveOk = 0;

  constructor(
    private readonly minMs = 3_000,
    private readonly maxMs = 300_000,
    startMs = 20_000,
    private readonly stepMs = 1_500,
    /** Speed up only after this many clean successes, so we probe cautiously. */
    private readonly successesBeforeSpeedup = 3,
  ) {
    this.intervalMs = startMs;
  }

  get current(): number { return this.intervalMs; }

  onSuccess(): void {
    this.consecutiveOk++;
    if (this.consecutiveOk >= this.successesBeforeSpeedup) {
      this.consecutiveOk = 0;
      this.intervalMs = Math.max(this.minMs, this.intervalMs - this.stepMs);
    }
  }

  onThrottle(): void {
    this.consecutiveOk = 0;
    this.intervalMs = Math.min(this.maxMs, Math.max(this.minMs, this.intervalMs * 2));
  }

  /** A non-throttle failure (timeout, DNS) — nudge back a little, don't panic. */
  onError(): void {
    this.consecutiveOk = 0;
    this.intervalMs = Math.min(this.maxMs, this.intervalMs + this.stepMs);
  }

  snapshot() { return { intervalMs: this.intervalMs, consecutiveOk: this.consecutiveOk }; }
}
