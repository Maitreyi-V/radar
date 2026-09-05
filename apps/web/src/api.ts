/** Types mirroring the server contract. Kept hand-written and small rather than generated. */
export type Freshness = 'LIVE' | 'DELAYED' | 'STALE' | 'MARKET_CLOSED' | 'REPLAY';

export interface QuoteView {
  symbol: string; name: string; price: number; volume: number | null;
  dayOpen: number | null; prevClose: number | null; dayHigh: number | null; dayLow: number | null;
  week52High: number | null; week52Low: number | null;
  changePct: number | null; refPrice: number | null; refChangePct: number | null;
  asOf: number; fetchedAt: number; source: string;
  freshness: Freshness; ageMs: number; sparkline: number[];
}

export interface ScoredEvent {
  symbol: string; type: string; magnitude: number; baseScore: number;
  score: number; recency: number; noveltyFactor: number;
  occurredAt: number; detail: Record<string, string | number | null>;
  dedupKey: string; explanation: string;
}

export interface DigestCard {
  symbol: string; name: string; price: number; changePct: number | null;
  events: ScoredEvent[]; headline: string; supporting: string[];
  score: number; freshness: Freshness; asOf: number;
}

export interface QuietDetail {
  symbol: string; name: string; price: number;
  changePct: number | null; sigmaPct: number | null; z: number | null; reason: string;
}

export interface Digest {
  watchlistId: string; since: number | null; sinceLabel: string; generatedAt: number;
  cards: DigestCard[]; quietCount: number; quietSymbols: string[]; isQuiet: boolean;
  marketPhase: 'OPEN' | 'PRE_OPEN' | 'CLOSED'; unavailable: string[];
  unconfirmed: Array<{ symbol: string; reason: string }>;
  quietDetail: QuietDetail[];
  sensitivity: number;
}

export interface StoredEvent {
  id: string; symbol: string; type: string; magnitude: number;
  score: number; occurredAt: number; explanation: string;
}

export interface CheckpointSummary { id: string; takenAt: number; symbols: number }

export interface Watchlist { id: string; name: string; version: number; symbols: string[] }

export type ReplayState = 'idle' | 'running' | 'paused' | 'finished';
export interface ReplayStatus {
  state: ReplayState; speed: number; sessionDate: string | null;
  step: number; totalSteps: number; simulatedAt: number | null;
  symbols: number; emitted: number;
}
export interface ReplaySession { sessionDate: string; ticks: number; symbols: number }
export interface User { id: string; email: string }

/** Raised on a 409 so callers can merge instead of blindly retrying. */
export class ConflictError extends Error {
  constructor(readonly current: { version: number; symbols: string[] }) {
    super('This watchlist changed in another tab');
    this.name = 'ConflictError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',                     // session cookie
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    throw new ConflictError(body.current ?? { version: 0, symbols: [] });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ ok: boolean; marketPhase: string; quotes: number; dailyBars: number }>('/api/health'),

  me: () => req<{ user: User; watchlists: Watchlist[]; isDemo: boolean }>('/api/auth/me'),
  resetDemo: () => req<{ ok: true; watchlistId: string; symbols: number; anchoredTo: string }>(
    '/api/demo/reset', { method: 'POST' }),
  signup: (email: string, password: string) =>
    req<{ user: User; watchlistId: string }>('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    req<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  watchlists: () => req<{ watchlists: Watchlist[] }>('/api/watchlists'),
  watchlist: (id: string) => req<{ watchlist: Watchlist; quotes: QuoteView[] }>(`/api/watchlists/${id}`),
  quotes: (id: string) => req<{ quotes: QuoteView[] }>(`/api/watchlists/${id}/quotes`),
  digest: (id: string, opts: { sensitivity?: number; fresh?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (opts.sensitivity !== undefined) p.set('sensitivity', String(opts.sensitivity));
    if (opts.fresh) p.set('fresh', '1');
    const qs = p.toString();
    return req<{ digest: Digest; cached: boolean }>(`/api/watchlists/${id}/digest${qs ? `?${qs}` : ''}`);
  },

  createWatchlist: (name: string) =>
    req<{ watchlist: Watchlist }>('/api/watchlists', { method: 'POST', body: JSON.stringify({ name }) }),
  renameWatchlist: (id: string, name: string) =>
    req<{ watchlist: Watchlist }>(`/api/watchlists/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteWatchlist: (id: string) => req<{ ok: true }>(`/api/watchlists/${id}`, { method: 'DELETE' }),
  checkpoints: (id: string) => req<{ checkpoints: CheckpointSummary[] }>(`/api/watchlists/${id}/checkpoints`),
  symbolEvents: (symbol: string, since = 0) =>
    req<{ symbol: string; events: StoredEvent[] }>(`/api/symbols/${encodeURIComponent(symbol)}/events?since=${since}`),

  addSymbol: (id: string, symbol: string, version?: number) =>
    req<{ watchlist: Watchlist }>(`/api/watchlists/${id}/symbols`, {
      method: 'POST', body: JSON.stringify({ symbol, version }),
    }),
  removeSymbol: (id: string, symbol: string, version?: number) =>
    req<{ watchlist: Watchlist }>(
      `/api/watchlists/${id}/symbols/${encodeURIComponent(symbol)}${version ? `?version=${version}` : ''}`,
      { method: 'DELETE' },
    ),
  checkpoint: (id: string) =>
    req<{ checkpoint: { id: string; takenAt: number; symbols: number } }>(`/api/watchlists/${id}/checkpoint`, { method: 'POST' }),

  replayStatus: () => req<{ status: ReplayStatus; sessions: ReplaySession[] }>('/api/replay/status'),
  replayStart: (speed: number, sessionDate?: string) =>
    req<{ status: ReplayStatus }>('/api/replay/start', { method: 'POST', body: JSON.stringify({ speed, sessionDate }) }),
  replayPause: () => req<{ status: ReplayStatus }>('/api/replay/pause', { method: 'POST' }),
  replayResume: () => req<{ status: ReplayStatus }>('/api/replay/resume', { method: 'POST' }),
  replayStop: () => req<{ status: ReplayStatus }>('/api/replay/stop', { method: 'POST' }),
  replaySpeed: (speed: number) =>
    req<{ status: ReplayStatus }>('/api/replay/speed', { method: 'POST', body: JSON.stringify({ speed }) }),
  replayReset: () => req<{ status: ReplayStatus }>('/api/replay/reset', { method: 'POST' }),

  search: (q: string) => req<{ results: Array<{ symbol: string; name: string }> }>(`/api/symbols/search?q=${encodeURIComponent(q)}`),
  history: (symbol: string) =>
    req<{ symbol: string; points: Array<{ asOf: number; price: number; volume: number | null }> }>(
      `/api/symbols/${encodeURIComponent(symbol)}/history`),
};
