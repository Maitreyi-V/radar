import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ConflictError, type Digest, type QuoteView, type User, type Watchlist } from './api';
import { useStream } from './useStream';
import { Auth } from './components/Auth';
import { AddSymbol } from './components/AddSymbol';
import { WatchlistTable } from './components/WatchlistTable';
import { DigestPanel } from './components/DigestPanel';
import { SymbolDrawer } from './components/SymbolDrawer';
import { ReplayBar } from './components/ReplayBar';
import { WatchlistPicker } from './components/WatchlistPicker';
import { SensitivityControl } from './components/SensitivityControl';
import { VisitHistory } from './components/VisitHistory';

type Tab = 'digest' | 'live';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booted, setBooted] = useState(false);
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [watchlist, setWatchlist] = useState<Watchlist | null>(null);
  const [sensitivity, setSensitivity] = useState(1.5);
  const [isDemo, setIsDemo] = useState(false);
  const [quotes, setQuotes] = useState<QuoteView[]>([]);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [tab, setTab] = useState<Tab>('digest');
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Record<string, 'up' | 'down' | undefined>>({});
  const prices = useRef<Record<string, number>>({});

  // ---- bootstrap ----
  const loadAll = useCallback(async (wid: string, sens = sensitivity, fresh = false) => {
    const [w, d, all] = await Promise.all([
      api.watchlist(wid),
      api.digest(wid, { sensitivity: sens, fresh }),
      api.watchlists(),
    ]);
    setWatchlist(w.watchlist); setQuotes(w.quotes); setDigest(d.digest); setWatchlists(all.watchlists);
    for (const q of w.quotes) prices.current[q.symbol] = q.price;
  }, [sensitivity]);

  useEffect(() => {
    api.me()
      .then(async ({ user, watchlists, isDemo }) => {
        setUser(user);
        setIsDemo(!!isDemo);
        setWatchlists(watchlists);
        const remembered = localStorage.getItem('radar.activeWatchlist');
        const wl = watchlists.find((w) => w.id === remembered) ?? watchlists[0];
        if (wl) await loadAll(wl.id);
      })
      .catch(() => setUser(null))
      .finally(() => setBooted(true));
  }, [loadAll]);

  const refresh = useCallback(async () => {
    if (watchlist) await loadAll(watchlist.id);
  }, [watchlist, loadAll]);

  /**
   * Cache-bypassing refresh, used while a replay is running.
   *
   * The 30s digest cache is right for ordinary use — it absorbs refresh-spam from a
   * returning user. But during replay the market state changes many times a second, and
   * serving a cached digest makes the UI look frozen while the replay bar advances. The
   * cache must not outlive the facts it summarises, so replay opts out of it.
   */
  const refreshLive = useCallback(async () => {
    if (watchlist) await loadAll(watchlist.id, sensitivity, true);
  }, [watchlist, loadAll, sensitivity]);

  async function changeSensitivity(v: number) {
    setSensitivity(v);
    if (!watchlist) return;
    const d = await api.digest(watchlist.id, { sensitivity: v });
    setDigest(d.digest);
  }

  async function switchWatchlist(id: string) {
    localStorage.setItem('radar.activeWatchlist', id);
    setTab('digest');
    await loadAll(id);
  }

  async function createWatchlist(name: string) {
    const { watchlist: w } = await api.createWatchlist(name);
    await switchWatchlist(w.id);
  }

  async function renameWatchlist(id: string, name: string) {
    await api.renameWatchlist(id, name);
    await loadAll(watchlist?.id ?? id);
  }

  async function removeWatchlist(id: string) {
    try {
      await api.deleteWatchlist(id);
      const rest = watchlists.filter((w) => w.id !== id);
      if (rest[0]) await switchWatchlist(rest[0].id);
    } catch (e) { await handleConflict(e); }
  }

  /**
   * Write a checkpoint when the user genuinely leaves.
   *
   * `sendBeacon` rather than fetch, because a normal request is cancelled during unload —
   * the browser will not wait for it.
   *
   * The DWELL GUARD is the important part. `visibilitychange` fires on every tab flick,
   * window switch and minimise. Checkpointing on all of them means a glance at the digest
   * silently moves the diff anchor, and the user returns to an empty "nothing changed" —
   * having never actually read what changed. Marking someone caught up on something they
   * did not read is the one failure this product cannot afford.
   *
   * So the anchor only moves if they stayed long enough to have actually read it.
   */
  const MIN_DWELL_MS = 30_000;
  const arrivedAt = useRef(Date.now());

  useEffect(() => {
    if (!watchlist) return;
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      // The demo account is shared. Moving its anchor is correct for a real user and
      // destructive here — the next visitor would land on "Quiet since you left".
      if (isDemo) return;
      if (Date.now() - arrivedAt.current < MIN_DWELL_MS) return;   // a glance, not a visit
      try { navigator.sendBeacon(`/api/watchlists/${watchlist.id}/checkpoint`); } catch { /* best effort */ }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [watchlist, isDemo]);

  async function resetDemo() {
    setBusy(true);
    try {
      const r = await api.resetDemo();
      localStorage.setItem('radar.activeWatchlist', r.watchlistId);
      await loadAll(r.watchlistId);
      setTab('digest');
      setNotice(`Demo reset — you are back to the close of ${r.anchoredTo}.`);
      setTimeout(() => setNotice(null), 4000);
    } catch (e) { await handleConflict(e); }
    finally { setBusy(false); }
  }

  // ---- live updates ----
  useStream(!!user, (ev) => {
    if (ev.type === 'quote') {
      const prev = prices.current[ev.symbol];
      if (prev !== undefined && prev !== ev.price) {
        const dir = ev.price > prev ? 'up' : 'down';
        setFlash((f) => ({ ...f, [ev.symbol]: dir }));
        setTimeout(() => setFlash((f) => ({ ...f, [ev.symbol]: undefined })), 900);
      }
      prices.current[ev.symbol] = ev.price;
      setQuotes((qs) => qs.map((q) => (q.symbol === ev.symbol
        ? { ...q, price: ev.price, asOf: ev.asOf, ageMs: 0, freshness: 'LIVE' as const }
        : q)));
    }
    // A checkpoint taken in ANOTHER tab must refresh this one's digest.
    if (ev.type === 'checkpoint' || ev.type === 'watchlist') void refresh();
  });

  // Age the freshness chips locally so "12s ago" keeps ticking without polling.
  useEffect(() => {
    const t = setInterval(() => setQuotes((qs) => qs.map((q) => ({ ...q, ageMs: Date.now() - q.asOf }))), 1000);
    return () => clearInterval(t);
  }, []);

  // ---- actions ----
  async function add(symbol: string) {
    if (!watchlist) return;
    try {
      const { watchlist: w } = await api.addSymbol(watchlist.id, symbol, watchlist.version);
      setWatchlist(w); await loadAll(w.id);
    } catch (e) { await handleConflict(e); }
  }

  async function remove(symbol: string) {
    if (!watchlist) return;
    try {
      const { watchlist: w } = await api.removeSymbol(watchlist.id, symbol, watchlist.version);
      setWatchlist(w); await loadAll(w.id);
    } catch (e) { await handleConflict(e); }
  }

  /** 409 -> tell the user plainly, then reload the authoritative state and continue. */
  async function handleConflict(e: unknown) {
    if (e instanceof ConflictError) {
      setNotice('This watchlist changed in another tab — reloaded the latest version.');
      await refresh();
      setTimeout(() => setNotice(null), 5000);
    } else {
      setNotice((e as Error).message ?? 'Something went wrong');
      setTimeout(() => setNotice(null), 5000);
    }
  }

  async function markCaughtUp() {
    if (!watchlist) return;
    setBusy(true);
    try { await api.checkpoint(watchlist.id); await refresh(); setTab('digest'); }
    finally { setBusy(false); }
  }

  const openQuote = useMemo(() => quotes.find((q) => q.symbol === open), [quotes, open]);

  if (!booted) return <div className="min-h-full grid place-items-center text-slate-600">Loading…</div>;
  if (!user) return <Auth onDone={() => location.reload()} />;

  return (
    <div className="min-h-full">
      <header className="border-b border-ink-850 sticky top-0 bg-ink-950/90 backdrop-blur z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-accent" />
            <span className="font-semibold text-slate-100">Radar</span>
          </div>

          <WatchlistPicker
            watchlists={watchlists} activeId={watchlist?.id ?? null}
            onSwitch={switchWatchlist} onCreate={createWatchlist}
            onRename={renameWatchlist} onDelete={removeWatchlist}
          />

          <nav className="flex items-center gap-1 ml-2">
            {(['digest', 'live'] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  tab === t ? 'bg-ink-800 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>
                {t === 'digest' ? 'Since you left' : 'Live'}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <AddSymbol onAdd={add} existing={watchlist?.symbols ?? []} />
            {isDemo && (
              <button onClick={resetDemo} disabled={busy}
                title="Put the shared demo account back to its 'since you left' state"
                className="text-xs text-slate-500 hover:text-accent">
                Reset demo
              </button>
            )}
            <button
              onClick={async () => {
                // Leaving is a "caught up" moment — anchor the diff before the session ends.
                // Skipped for the shared demo account, which many people open in turn.
                if (watchlist && !isDemo) { try { await api.checkpoint(watchlist.id); } catch { /* still sign out */ } }
                await api.logout();
                location.reload();
              }}
              className="text-xs text-slate-500 hover:text-slate-300">Sign out</button>
          </div>
        </div>
      </header>

      {notice && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-3">
          <div className="card px-4 py-2.5 text-sm text-amber-300 border-amber-500/20 bg-amber-500/5">{notice}</div>
        </div>
      )}

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <ReplayBar onTick={refreshLive} />

        {tab === 'digest' && digest && (
          <>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <SensitivityControl value={sensitivity} onChange={changeSensitivity} disabled={busy} />
              <span className="text-[11px] text-slate-600">
                {digest.cards.length} surfaced · {digest.quietCount} quiet
              </span>
            </div>
            <DigestPanel digest={digest} onOpen={setOpen} onCaughtUp={markCaughtUp} busy={busy} />
            <VisitHistory watchlistId={digest.watchlistId} currentSince={digest.since} />
          </>
        )}
        {tab === 'live' && (
          <WatchlistTable quotes={quotes} onRemove={remove} onOpen={setOpen} flash={flash} />
        )}
      </main>

      {open && (
        <SymbolDrawer symbol={open} quote={openQuote} checkpointAt={digest?.since ?? null}
          onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
