import { useEffect, useRef } from 'react';

/**
 * SSE subscription.
 *
 * EventSource reconnects on its own after a drop — one of the main reasons SSE beats
 * WebSockets here. The handler is held in a ref so re-renders never tear down and
 * rebuild the connection.
 */
export type StreamEvent =
  | { type: 'quote'; symbol: string; price: number; asOf: number; source: string }
  | { type: 'checkpoint'; watchlistId: string; takenAt: number }
  | { type: 'watchlist'; watchlistId: string; version: number }
  | { type: 'hello'; at: number };

export function useStream(enabled: boolean, onEvent: (e: StreamEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource('/api/stream', { withCredentials: true });
    const forward = (ev: MessageEvent) => {
      try { handler.current(JSON.parse(ev.data) as StreamEvent); } catch { /* ignore malformed frame */ }
    };
    for (const t of ['quote', 'checkpoint', 'watchlist', 'hello']) es.addEventListener(t, forward as EventListener);
    return () => es.close();
  }, [enabled]);
}
