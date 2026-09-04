/**
 * Per-provider circuit breaker.
 *
 * Why: free market-data APIs rate-limit and flap. Without a breaker, every poll
 * cycle keeps hammering a dead provider, and each request pays the full timeout —
 * so provider latency becomes OUR latency. The breaker fails fast instead.
 *
 * CLOSED --(failureThreshold consecutive failures)--> OPEN
 * OPEN   --(after openMs)--> HALF_OPEN  (single probe allowed)
 * HALF_OPEN --success--> CLOSED   |   --failure--> OPEN (timer resets)
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private _state: BreakerState = 'CLOSED';
  readonly log: Array<{ at: number; msg: string }> = [];

  constructor(
    readonly name: string,
    private readonly failureThreshold = 3,
    private readonly openMs = 60_000,
  ) {}

  get state(): BreakerState {
    if (this._state === 'OPEN' && Date.now() - this.openedAt >= this.openMs) {
      this.transition('HALF_OPEN', 'cooldown elapsed, probing');
    }
    return this._state;
  }

  /** False when the call should be short-circuited without touching the network. */
  canRequest(): boolean {
    const s = this.state;
    if (s === 'CLOSED') return true;
    if (s === 'OPEN') return false;
    // HALF_OPEN: let exactly one probe through.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.probeInFlight = false;
    this.failures = 0;
    if (this._state !== 'CLOSED') this.transition('CLOSED', 'probe succeeded');
  }

  onFailure(reason: string): void {
    this.probeInFlight = false;
    this.failures++;
    if (this._state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.transition('OPEN', `opened after ${this.failures} failure(s): ${reason}`);
    }
  }

  private transition(to: BreakerState, msg: string): void {
    this._state = to;
    this.log.push({ at: Date.now(), msg: `[${this.name}] -> ${to}: ${msg}` });
    if (this.log.length > 50) this.log.shift();
  }

  snapshot() {
    return { name: this.name, state: this.state, failures: this.failures };
  }
}
