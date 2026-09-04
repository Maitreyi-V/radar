import { CircuitBreaker } from './circuitBreaker.js';
import type { ProviderAdapter, Quote } from './types.js';
import { writeQuote, type WriteResult } from './store.js';
import { marketPhase } from './marketCalendar.js';

export interface SchedulerStats {
  cycles: number; inserted: number; duplicate: number; stale: number; failed: number; disputed: number;
  lastCycleAt: number | null; lastCycleMs: number | null;
}

type QuoteListener = (q: Quote) => void;

/**
 * Polls every symbol in the universe on an interval and persists the results.
 *
 * The scaling property that matters: this loop iterates the SYMBOL UNIVERSE, not users.
 * 10 users or 10,000 users watching TCS cause exactly one TCS fetch per interval.
 * Fan-out to users happens downstream over SSE, which is cheap.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private listeners: QuoteListener[] = [];
  readonly breakers = new Map<string, CircuitBreaker>();
  readonly stats: SchedulerStats = {
    cycles: 0, inserted: 0, duplicate: 0, stale: 0, failed: 0, disputed: 0,
    lastCycleAt: null, lastCycleMs: null,
  };

  constructor(
    /** Ordered by preference: providers[0] is primary, the rest are fallbacks. */
    private readonly providers: ProviderAdapter[],
    private readonly symbols: string[],
    private readonly intervalMs: number,
    private readonly concurrency = 4,
  ) {
    for (const p of providers) this.breakers.set(p.name, new CircuitBreaker(p.name));
  }

  onQuote(fn: QuoteListener): void { this.listeners.push(fn); }

  start(): void {
    if (this.timer) return;
    void this.cycle();
    this.timer = setInterval(() => void this.cycle(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Adapter chain: try each provider in order, skipping any whose breaker is open.
   * If every provider fails, we simply keep the last-known-good quote already in the
   * DB — the app degrades to DELAYED rather than going blank.
   */
  private async fetchOne(symbol: string): Promise<{ result: WriteResult | 'failed'; quote?: Quote }> {
    for (const provider of this.providers) {
      const breaker = this.breakers.get(provider.name)!;
      if (!breaker.canRequest()) continue;
      try {
        const quote = await provider.fetchQuote(symbol);
        breaker.onSuccess();
        return { result: writeQuote(quote), quote };
      } catch (err: any) {
        breaker.onFailure(err?.message ?? 'unknown');
      }
    }
    return { result: 'failed' };
  }

  /** One pass over the universe with a bounded worker pool. */
  private async cycle(): Promise<void> {
    if (this.running) return;              // never overlap cycles
    this.running = true;
    const started = Date.now();
    const queue = [...this.symbols];

    const worker = async (): Promise<void> => {
      for (;;) {
        const symbol = queue.shift();
        if (!symbol) return;
        const { result, quote } = await this.fetchOne(symbol);
        if (result === 'failed') this.stats.failed++;
        else this.stats[result]++;
        if (result === 'inserted' && quote) {
          for (const fn of this.listeners) { try { fn(quote); } catch { /* listener must not break ingestion */ } }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
      this.stats.cycles++;
      this.stats.lastCycleAt = Date.now();
      this.stats.lastCycleMs = Date.now() - started;
    } finally {
      this.running = false;
    }
  }

  snapshot() {
    return {
      phase: marketPhase(),
      symbols: this.symbols.length,
      intervalMs: this.intervalMs,
      stats: this.stats,
      breakers: [...this.breakers.values()].map((b) => b.snapshot()),
    };
  }
}
