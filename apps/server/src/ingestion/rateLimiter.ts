/**
 * Token bucket, shared per provider.
 *
 * Measured 2026-09-04 against Yahoo v8: 60 symbols at concurrency 4 with no pacing
 * -> HTTP 429 on every request. The same 60 symbols issued sequentially at a ~300ms
 * gap -> 100% success, including heavy range=1y responses. Yahoo throttles on
 * BURST/CONCURRENCY, not on sustained volume, so the fix is pacing, not backing off.
 *
 * `capacity` allows a small burst (useful for one-off UI lookups) while
 * `refillPerSec` bounds the sustained rate.
 */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private queue: Array<() => void> = [];
  private draining = false;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
  }

  /** Resolves when a token is available. FIFO, so no request can starve. */
  take(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        this.queue.shift()!();
      } else {
        const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
        await sleep(waitMs);
      }
    }
    this.draining = false;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Full jitter backoff (AWS-style): random in [0, base * 2^attempt], capped. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 20_000): number {
  return Math.floor(Math.random() * Math.min(capMs, baseMs * 2 ** attempt));
}
