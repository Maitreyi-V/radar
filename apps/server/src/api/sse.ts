import type { FastifyReply } from 'fastify';

/**
 * Server-Sent Events hub.
 *
 * SSE over WebSockets: the data flow here is strictly one-directional (server -> browser).
 * SSE gives us automatic reconnection in the browser for free, rides ordinary HTTP so
 * proxies and load balancers need no special handling, and has a far simpler failure
 * model. A WebSocket would buy bidirectional messaging we would never use.
 */
export type RadarEvent =
  | { type: 'quote'; symbol: string; price: number; asOf: number; source: string }
  | { type: 'checkpoint'; watchlistId: string; takenAt: number }
  | { type: 'watchlist'; watchlistId: string; version: number }
  | { type: 'replay'; status: string; at: number; speed?: number }
  | { type: 'provider'; name: string; state: string }
  | { type: 'hello'; at: number };

interface Client { id: number; userId: string; reply: FastifyReply }

export class SseHub {
  private clients = new Map<number, Client>();
  private nextId = 1;

  add(userId: string, reply: FastifyReply): number {
    const id = this.nextId++;
    this.clients.set(id, { id, userId, reply });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers text/event-stream by default, which delays every event.
      'X-Accel-Buffering': 'no',
    });
    // Tell the browser to wait 3s before reconnecting after a drop.
    reply.raw.write('retry: 3000\n\n');
    this.send(id, { type: 'hello', at: Date.now() });

    reply.raw.on('close', () => { this.clients.delete(id); });
    return id;
  }

  private send(id: number, event: RadarEvent): void {
    const c = this.clients.get(id);
    if (!c) return;
    try {
      c.reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.clients.delete(id);
    }
  }

  /** Broadcast to every connected client (quotes are not user-specific). */
  broadcast(event: RadarEvent): void {
    for (const id of [...this.clients.keys()]) this.send(id, event);
  }

  /** Send only to one user's connections — e.g. a checkpoint they took in another tab. */
  toUser(userId: string, event: RadarEvent): void {
    for (const [id, c] of this.clients) if (c.userId === userId) this.send(id, event);
  }

  /** Comment-only frames keep proxies from reaping an idle connection. */
  startHeartbeat(ms = 25_000): NodeJS.Timeout {
    return setInterval(() => {
      for (const c of this.clients.values()) {
        try { c.reply.raw.write(`: ping\n\n`); } catch { this.clients.delete(c.id); }
      }
    }, ms);
  }

  get size(): number { return this.clients.size; }
}

export const hub = new SseHub();
