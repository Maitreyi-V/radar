/**
 * Radar server — a modular monolith.
 *
 * One process, sharply separated modules: ingestion / significance / digest / replay / api.
 * The module boundaries are exactly where services would be cut later; at this scale a
 * network hop between them would add failure modes without adding value.
 */
// ═══════════════════════════════════════════════════════════════════════════
// READ THIS FILE TOP-TO-BOTTOM AND YOU HAVE READ THE WHOLE SYSTEM.
// This is the entry point: `npm run dev` runs exactly this file.
//
// It does 4 jobs, in order:
//   1. Build the web server and plug in the API routes      (lines ~40-75)
//   2. Start ingestion — the "while you're away" loop       (lines ~85-105)
//   3. Wire the live push channel (SSE) to the browser      (lines ~95, 110)
//   4. Listen on a port, and shut down cleanly on Ctrl+C    (lines ~115-130)
// ═══════════════════════════════════════════════════════════════════════════

// ---- Third-party packages (from node_modules) ----
import Fastify from 'fastify';              // the web framework. Java: Spring Boot. Python: FastAPI.
import cookie from '@fastify/cookie';       // lets the server read/write browser cookies (for login)
import cors from '@fastify/cors';           // lets the browser on :5173 talk to this server on :4000
import fastifyStatic from '@fastify/static'; // serves the built React files in production

// ---- Node built-ins ----
import path from 'node:path';
import fs from 'node:fs';                   // filesystem: used once, to check if a folder exists

// ---- My own modules. './' means "a file in MY project, relative to this one". ----
// The { braces } mean "pick these NAMED exports out of that file".
import { CONFIG } from './config.js';
import { registerRoutes } from './api/routes.js';
import { hub } from './api/sse.js';                              // the live-push broadcaster
import { BseAdapter } from './ingestion/adapters/bse.js';        // primary price provider
import { YahooAdapter } from './ingestion/adapters/yahoo.js';    // fallback price provider
import { Scheduler } from './ingestion/scheduler.js';            // the "poll every 30s" loop
import { UNIVERSE, UNIVERSE_SYMBOLS } from './ingestion/universe.js'; // the list of stocks we track
import { writeSymbols } from './ingestion/store.js';
import { prioritise } from './ingestion/priority.js';
import { marketPhase } from './ingestion/marketCalendar.js';     // OPEN / CLOSED / PRE_OPEN
import { replay, clearStrandedReplayRows } from './replay/engine.js';

// Create the server object. Fastify(...) takes one options object.
const app = Fastify({
  // How chatty the logs are. 'warn' = only warnings and errors, keeps the terminal readable.
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  // SSE responses must never be buffered or timed out by the framework.
  // SSE = Server-Sent Events: a response that STAYS OPEN forever and keeps
  // dripping new prices to the browser. Fastify's default is to kill slow
  // connections — 0 disables that, otherwise live updates would die after ~1 min.
  connectionTimeout: 0,
});

/**
 * Everything happens inside main() for ONE reason: `await` is only legal inside
 * an `async` function. Since startup is full of slow steps (registering plugins,
 * opening a port), they all need awaiting — so they all need to live in here.
 *
 * Promise<void> = "this function finishes eventually and hands back nothing".
 */
async function main(): Promise<void> {
  // register = "plug this plugin into the server". Each returns a Promise, so each is awaited.
  // ORDER MATTERS: cookie must be registered before routes, because the routes
  // read req.cookies — a route registered first would see an undefined helper.
  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, true),  // allow any origin (fine for a hackathon demo)
    credentials: true,     // required: the session cookie must ride cross-origin in dev
  });
  await registerRoutes(app);   // <- every /api/... endpoint gets attached here. See api/routes.ts.

  /**
   * In production the monolith also serves the built frontend, so the whole app is one
   * container on one port — no nginx, no separate static host, no CORS. In development
   * Vite serves the UI and proxies /api here instead, so this is skipped.
   */
  const webDist = path.resolve(process.cwd(), '../web/dist');
  // The `if` is the dev/prod switch. No build folder = we're on a laptop = skip all this.
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    // SPA fallback: any non-API path that is not a real file returns index.html so
    // client-side routing works on a hard refresh.
    // (SPA = Single Page App. React owns the URL bar, so the SERVER must hand back
    //  index.html for unknown paths and let React decide what to render.)
    app.setNotFoundHandler((req, reply) => {
      // A missing /api/ route is a genuine 404 — never disguise it as a web page.
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
    console.log(`serving frontend from ${webDist}`);
  }

  // Copy the stock list into the DB so the search box has names to match against.
  // .map() transforms each item; here it strips each entry down to just {symbol, name}.
  writeSymbols(UNIVERSE.map((s) => ({ symbol: s.symbol, name: s.name })));

  // Replay output must never outlive the process that produced it (see engine.ts).
  // If the server was killed mid-replay, fake prices could still be sitting in the DB.
  // Deleting them at boot guarantees a restart always begins from real data only.
  const stranded = clearStrandedReplayRows();
  if (stranded > 0) console.log(`cleared ${stranded} stranded replay rows from a previous run`);

  // Ingestion runs in-process. Crucially it polls the SYMBOL UNIVERSE, not users:
  // 10 or 10,000 users watching TCS still cause exactly one TCS fetch per interval.
  //
  // ^^^ THIS COMMENT IS THE "once" SLIDE (slide 11). Work scales with SYMBOLS, not USERS.
  //
  // `new Scheduler(...)` creates an object from a class — same as Java/Python.
  const scheduler = new Scheduler(
    [new BseAdapter(), new YahooAdapter()],  // provider chain, IN ORDER: try BSE, then Yahoo
    prioritise(UNIVERSE_SYMBOLS),            // which symbols to poll, most-important first
    CONFIG.pollIntervalMs,                   // 30 seconds
    1,                                   // strictly sequential — concurrency is what trips rate limits
  );

  // "Whenever you get a new quote, run this function." A CALLBACK.
  // The scheduler doesn't know what SSE is; it just calls whatever it was handed.
  // That decoupling is why ingestion can be tested without a browser anywhere.
  scheduler.onQuote((q) => {
    hub.broadcast({ type: 'quote', symbol: q.symbol, price: q.price, asOf: q.asOf, source: q.source });
  });

  // Reconcile continuously instead of checking only once at boot. A process that starts
  // before 09:15 must begin ingesting when the market opens, and stop after the close.
  let ingestionRunning = false;   // `let`, not `const` — this genuinely flips back and forth.
  const reconcileIngestion = () => {
    // Two conditions: the kill-switch env var is off, AND the market is actually open.
    const shouldRun = process.env.RADAR_NO_INGEST !== '1' && marketPhase() === 'OPEN';
    // Start only on a false->true transition, stop only on true->false.
    // Without these guards, this would call start() every 30s on an already-running scheduler.
    if (shouldRun && !ingestionRunning) { scheduler.start(); ingestionRunning = true; }
    if (!shouldRun && ingestionRunning) { scheduler.stop(); ingestionRunning = false; }
  };
  reconcileIngestion();                                          // decide once, right now
  const ingestionSupervisor = setInterval(reconcileIngestion, 30_000);  // then re-decide every 30s
  // setInterval returns a handle. We keep it so shutdown() can cancel it — otherwise
  // the timer keeps the Node process alive and Ctrl+C appears to hang.

  // Replayed ticks ride the same SSE channel as live ones — the browser cannot tell
  // them apart, which is the point: the demo exercises the real path.
  replay.onQuote((q) => {
    hub.broadcast({ type: 'quote', symbol: q.symbol, price: q.price, asOf: q.asOf, source: q.source });
  });

  // Sends a tiny "still here" ping down every open SSE connection every few seconds,
  // so proxies and load balancers don't quietly close an idle stream.
  const heartbeat = hub.startHeartbeat();

  // THE BLOCKING LINE. Until now nothing was reachable; now the port is open.
  // host '0.0.0.0' = "accept connections from anywhere", required inside Docker,
  // where the default 'localhost' would only accept traffic from inside the container.
  await app.listen({ port: CONFIG.port, host: '0.0.0.0' });
  console.log(`radar server on :${CONFIG.port}  phase=${marketPhase()}  ingest=${marketPhase() === 'OPEN' ? 'on' : 'idle'}`);
  //                                                                            ^^^ ternary:  condition ? ifTrue : ifFalse

  // GRACEFUL SHUTDOWN: stop the timers, stop polling, close the server, then exit.
  // Without this, Ctrl+C could kill the process mid-database-write.
  const shutdown = async () => {
    clearInterval(heartbeat);
    clearInterval(ingestionSupervisor);
    scheduler.stop();
    await app.close();
    process.exit(0);          // 0 = "exited successfully"
  };
  process.on('SIGINT', shutdown);   // SIGINT  = you pressed Ctrl+C
  process.on('SIGTERM', shutdown);  // SIGTERM = the host (Render/Docker) asked us to stop
}

// Actually run it. main() is async, so it returns a Promise.
// .catch(...) is the ONLY error handler for startup: if anything above throws,
// print it and exit with code 1 (= failure), so the host knows the boot failed
// instead of leaving a dead process that looks alive.
main().catch((err) => { console.error(err); process.exit(1); });
