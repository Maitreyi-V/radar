import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// Side-effect import: pulls in @fastify/cookie's declaration merging so req.cookies,
// reply.setCookie and reply.clearCookie are typed.
import '@fastify/cookie';
import { CONFIG } from '../config.js';
import {
  createUser, findUserByEmail, verifyPassword, createSession,
  userForSession, destroySession, type User,
} from './auth.js';
import {
  listWatchlists, createWatchlist, getWatchlist, addSymbol, removeSymbol,
  writeCheckpoint, renameWatchlist, deleteWatchlist, checkpointHistory, ConflictError,
} from './watchlists.js';
import { buildDigest } from '../digest/build.js';
import { getCached, setCached, invalidate } from '../digest/cache.js';
import { eventsForSymbol } from '../digest/events.js';
import { unconfirmed } from '../ingestion/conflict.js';
import { ensureQuote } from '../ingestion/onDemand.js';
import { resetDemo, DEMO_EMAIL } from '../demo/reset.js';
import { watchlistQuotes, symbolHistory, searchSymbols } from './quotesView.js';
import { hub } from './sse.js';
import { marketPhase } from '../ingestion/marketCalendar.js';
import { replay, ReplayEngine } from '../replay/engine.js';
import { db } from '../db/index.js';

const COOKIE = 'radar_session';

function currentUser(req: FastifyRequest): User | null {
  return userForSession((req.cookies as Record<string, string | undefined>)?.[COOKIE]);
}

function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  const u = currentUser(req);
  if (!u) { void reply.code(401).send({ error: 'not authenticated' }); return null; }
  return u;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ---------- health ----------
  app.get('/api/health', async () => ({
    ok: true,
    marketPhase: marketPhase(),
    sseClients: hub.size,
    quotes: (db.prepare(`SELECT COUNT(*) n FROM quotes`).get() as { n: number }).n,
    symbols: (db.prepare(`SELECT COUNT(*) n FROM symbols`).get() as { n: number }).n,
    dailyBars: (db.prepare(`SELECT COUNT(*) n FROM daily_bars`).get() as { n: number }).n,
    events: (db.prepare(`SELECT COUNT(*) n FROM events`).get() as { n: number }).n,
    unconfirmed: unconfirmed.all(),
  }));

  // ---------- auth ----------
  app.post('/api/auth/signup', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || !password || password.length < 6) {
      return reply.code(400).send({ error: 'email and a password of at least 6 characters are required' });
    }
    if (findUserByEmail(email)) return reply.code(409).send({ error: 'that email is already registered' });

    const user = createUser(email, password);
    const wl = createWatchlist(user.id, 'My Watchlist');
    setSessionCookie(reply, createSession(user.id));
    return { user, watchlistId: wl.id };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    const row = email ? findUserByEmail(email) : undefined;
    // Same message and shape whether the email or the password was wrong — otherwise
    // the endpoint becomes an account-enumeration oracle.
    if (!row || !password || !verifyPassword(password, row.pw_hash)) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    setSessionCookie(reply, createSession(row.id));
    return { user: { id: row.id, email: row.email } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession((req.cookies as Record<string, string | undefined>)?.[COOKIE]);
    void reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: 'not authenticated' });
    // The client uses this to skip the auto-checkpoint and offer a reset control.
    return { user, watchlists: listWatchlists(user.id), isDemo: user.email === DEMO_EMAIL };
  });

  /**
   * Put the shared demo account back to its "since you left" state.
   *
   * Restricted to the demo account: it deletes and recreates that user's watchlist, which
   * would be destructive for anyone else. Everything it writes is derived from recorded
   * data, so it is reproducible rather than a fixture.
   */
  app.post('/api/demo/reset', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    if (user.email !== DEMO_EMAIL) {
      return reply.code(403).send({ error: 'only the demo account can be reset' });
    }
    try {
      const result = resetDemo(user.id);
      invalidate(result.watchlistId);
      return { ok: true, ...result };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'reset failed' });
    }
  });

  // ---------- watchlists ----------
  app.get('/api/watchlists', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    return { watchlists: listWatchlists(user.id) };
  });

  app.post('/api/watchlists', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { name } = (req.body ?? {}) as { name?: string };
    return { watchlist: createWatchlist(user.id, (name ?? 'Watchlist').slice(0, 60)) };
  });

  app.patch('/api/watchlists/:id', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });
    try {
      const wl = renameWatchlist(user.id, id, name.trim().slice(0, 60));
      invalidate(id);
      return { watchlist: wl };
    } catch (err) { return handleWriteError(err, reply); }
  });

  app.delete('/api/watchlists/:id', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    // Never leave the user with zero watchlists — there would be nothing to render.
    if (listWatchlists(user.id).length <= 1) {
      return reply.code(400).send({ error: 'you need at least one watchlist' });
    }
    try {
      deleteWatchlist(user.id, id);
      invalidate(id);
      return { ok: true };
    } catch (err) { return handleWriteError(err, reply); }
  });

  /** Past visits — the memory, made browsable. */
  app.get('/api/watchlists/:id/checkpoints', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    if (!getWatchlist(user.id, id)) return reply.code(404).send({ error: 'watchlist not found' });
    return { checkpoints: checkpointHistory(user.id, id) };
  });

  app.get('/api/watchlists/:id', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const wl = getWatchlist(user.id, (req.params as { id: string }).id);
    if (!wl) return reply.code(404).send({ error: 'watchlist not found' });
    return { watchlist: wl, quotes: watchlistQuotes(wl.id) };
  });

  app.post('/api/watchlists/:id/symbols', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const { symbol, version } = (req.body ?? {}) as { symbol?: string; version?: number };
    if (!symbol) return reply.code(400).send({ error: 'symbol is required' });
    const sym = symbol.toUpperCase();
    // Fetch a price for symbols outside the scheduled universe BEFORE inserting, so
    // ref_price ("since you added") is stamped correctly. Best-effort: if the provider
    // is down the add still succeeds and the digest reports the symbol as unavailable.
    await ensureQuote(sym);
    try {
      const wl = addSymbol(user.id, id, sym, version);
      invalidate(id);
      hub.toUser(user.id, { type: 'watchlist', watchlistId: id, version: wl.version });
      return { watchlist: wl };   // 200 even if it was already there — idempotent add
    } catch (err) { return handleWriteError(err, reply); }
  });

  app.delete('/api/watchlists/:id/symbols/:symbol', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { id, symbol } = req.params as { id: string; symbol: string };
    const version = (req.query as { version?: string }).version;
    try {
      const wl = removeSymbol(user.id, id, symbol.toUpperCase(), version ? Number(version) : undefined);
      invalidate(id);
      hub.toUser(user.id, { type: 'watchlist', watchlistId: id, version: wl.version });
      return { watchlist: wl };
    } catch (err) { return handleWriteError(err, reply); }
  });

  // ---------- checkpoint + digest ----------
  app.post('/api/watchlists/:id/checkpoint', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    try {
      const cp = writeCheckpoint(user.id, id);
      invalidate(id);   // the diff anchor moved; every cached digest is now wrong
      // Other tabs must refresh their digest — this is the two-tab race from the plan.
      hub.toUser(user.id, { type: 'checkpoint', watchlistId: id, takenAt: cp.takenAt });
      return { checkpoint: cp };
    } catch (err) { return handleWriteError(err, reply); }
  });

  app.get('/api/watchlists/:id/digest', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    if (!getWatchlist(user.id, id)) return reply.code(404).send({ error: 'watchlist not found' });
    const limit = Number((req.query as { limit?: string }).limit ?? 5);
    const fresh = (req.query as { fresh?: string }).fresh === '1';
    const sens = (req.query as { sensitivity?: string }).sensitivity;
    const sensitivity = sens === undefined ? undefined : Number(sens);
    const cacheKey = limit + (sensitivity ?? 0) * 1000;   // sensitivity is part of the identity
    if (!fresh) {
      const cached = getCached(user.id, id, cacheKey);
      if (cached) return { digest: cached, cached: true };
    }
    const digest = buildDigest({ userId: user.id, watchlistId: id, limit, sensitivity });
    setCached(user.id, id, cacheKey, digest);
    return { digest, cached: false };
  });

  app.get('/api/watchlists/:id/quotes', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    if (!getWatchlist(user.id, id)) return reply.code(404).send({ error: 'watchlist not found' });
    return { quotes: watchlistQuotes(id) };
  });

  // ---------- symbols ----------
  app.get('/api/symbols/search', async (req) => {
    const q = ((req.query as { q?: string }).q ?? '').trim();
    return { results: q.length === 0 ? [] : searchSymbols(q) };
  });

  /** Event timeline for the drill-down: what fired on this symbol, and when. */
  app.get('/api/symbols/:symbol/events', async (req) => {
    const { symbol } = req.params as { symbol: string };
    const since = Number((req.query as { since?: string }).since ?? 0);
    return { symbol, events: eventsForSymbol(symbol.toUpperCase(), since) };
  });

  app.get('/api/symbols/:symbol/history', async (req) => {
    const { symbol } = req.params as { symbol: string };
    return { symbol, points: symbolHistory(symbol.toUpperCase()) };
  });

  // ---------- replay ----------
  // The judging window is mostly market-closed, so replay is how the product stays
  // demonstrable. It feeds the same pipeline as live data — see replay/engine.ts.
  app.get('/api/replay/status', async () => ({
    status: replay.status(),
    sessions: ReplayEngine.availableSessions(),
  }));

  app.post('/api/replay/start', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { speed, sessionDate } = (req.body ?? {}) as { speed?: number; sessionDate?: string };
    try {
      const status = await replay.start({ speed, sessionDate });
      return { status };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'could not start replay' });
    }
  });

  app.post('/api/replay/pause', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    return { status: replay.pause() };
  });

  app.post('/api/replay/resume', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    return { status: replay.resume() };
  });

  app.post('/api/replay/stop', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    return { status: replay.stop() };
  });

  app.post('/api/replay/speed', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { speed } = (req.body ?? {}) as { speed?: number };
    return { status: replay.setSpeed(Number(speed ?? 60)) };
  });

  /** Deletes every replayed row, restoring the view to the real recorded tape. */
  app.post('/api/replay/reset', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    return { status: replay.reset() };
  });

  // ---------- SSE ----------
  app.get('/api/stream', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    hub.add(user.id, reply);
    // Never resolve: Fastify must not end the response for a streaming endpoint.
    return new Promise<never>(() => {});
  });
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(CONFIG.sessionTtlMs / 1000),
  });
}

/** Maps domain errors onto status codes; 409 carries the fresh state to merge. */
function handleWriteError(err: unknown, reply: FastifyReply) {
  if (err instanceof ConflictError) {
    return reply.code(409).send({ error: err.message, current: err.current });
  }
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 404) return reply.code(404).send({ error: 'watchlist not found' });
  throw err;
}
