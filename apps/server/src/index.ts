/**
 * Radar server — a modular monolith.
 *
 * One process, sharply separated modules: ingestion / significance / digest / replay / api.
 * The module boundaries are exactly where services would be cut later; at this scale a
 * network hop between them would add failure modes without adding value.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { CONFIG } from './config.js';
import { registerRoutes } from './api/routes.js';
import { hub } from './api/sse.js';
import { BseAdapter } from './ingestion/adapters/bse.js';
import { YahooAdapter } from './ingestion/adapters/yahoo.js';
import { Scheduler } from './ingestion/scheduler.js';
import { UNIVERSE, UNIVERSE_SYMBOLS } from './ingestion/universe.js';
import { writeSymbols } from './ingestion/store.js';
import { prioritise } from './ingestion/priority.js';
import { marketPhase } from './ingestion/marketCalendar.js';
import { replay, clearStrandedReplayRows } from './replay/engine.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  // SSE responses must never be buffered or timed out by the framework.
  connectionTimeout: 0,
});

async function main(): Promise<void> {
  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, true),
    credentials: true,     // required: the session cookie must ride cross-origin in dev
  });
  await registerRoutes(app);

  /**
   * In production the monolith also serves the built frontend, so the whole app is one
   * container on one port — no nginx, no separate static host, no CORS. In development
   * Vite serves the UI and proxies /api here instead, so this is skipped.
   */
  const webDist = path.resolve(process.cwd(), '../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    // SPA fallback: any non-API path that is not a real file returns index.html so
    // client-side routing works on a hard refresh.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
    console.log(`serving frontend from ${webDist}`);
  }

  writeSymbols(UNIVERSE.map((s) => ({ symbol: s.symbol, name: s.name })));

  // Replay output must never outlive the process that produced it (see engine.ts).
  const stranded = clearStrandedReplayRows();
  if (stranded > 0) console.log(`cleared ${stranded} stranded replay rows from a previous run`);

  // Ingestion runs in-process. Crucially it polls the SYMBOL UNIVERSE, not users:
  // 10 or 10,000 users watching TCS still cause exactly one TCS fetch per interval.
  const scheduler = new Scheduler(
    [new BseAdapter(), new YahooAdapter()],
    prioritise(UNIVERSE_SYMBOLS),
    CONFIG.pollIntervalMs,
    1,                                   // strictly sequential — concurrency is what trips rate limits
  );
  scheduler.onQuote((q) => {
    hub.broadcast({ type: 'quote', symbol: q.symbol, price: q.price, asOf: q.asOf, source: q.source });
  });
  if (process.env.RADAR_NO_INGEST !== '1' && marketPhase() === 'OPEN') scheduler.start();

  // Replayed ticks ride the same SSE channel as live ones — the browser cannot tell
  // them apart, which is the point: the demo exercises the real path.
  replay.onQuote((q) => {
    hub.broadcast({ type: 'quote', symbol: q.symbol, price: q.price, asOf: q.asOf, source: q.source });
  });

  const heartbeat = hub.startHeartbeat();

  await app.listen({ port: CONFIG.port, host: '0.0.0.0' });
  console.log(`radar server on :${CONFIG.port}  phase=${marketPhase()}  ingest=${marketPhase() === 'OPEN' ? 'on' : 'idle'}`);

  const shutdown = async () => {
    clearInterval(heartbeat);
    scheduler.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
