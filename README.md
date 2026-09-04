# Radar — a watchlist with memory

**Most watchlists answer "what is the price?" Radar answers "what did I miss, and does it matter?"**

A watchlist that remembers what you last saw, watches while you're gone, and greets you with a
ranked, explainable digest of what actually changed — never a wall of numbers. It is confident
enough to tell you when nothing happened.

Built for CODE 2026 by Groww · Fri 4 Sep – Mon 7 Sep 2026

---

## Run it in two commands

```bash
npm install
npm run dev
```

Then open **http://localhost:5173** and sign in with the seeded demo account:

```
demo@radar.dev  /  radar123
```

No Docker, no database server, no API keys. The repo ships with **a real recorded NSE trading
session** (Friday 4 Sep 2026, 09:15–15:33 IST), so the product is fully demonstrable even
though the market is closed all weekend. See [Why the market being closed is a feature](#4-why-the-market-being-closed-is-a-feature).

```bash
npm test            # 114 tests
npm run explain     # the volatility table behind the thesis
npm run seed        # reset the demo account's checkpoint to yesterday's close
```

> The checkpoint moves when you genuinely leave (sign out, or ~30s+ then close the tab), which
> is the product working as intended. `npm run seed` puts the demo anchor back to yesterday's
> close if you want to replay the "since you left" moment.

Or in Docker — one container, no database service, recorded session baked in:

```bash
docker compose up --build     # -> http://localhost:4000
```

---

## 1. The thesis

"Meaningfully changed" is the entire problem in the brief, and the obvious reading of it is wrong.

The obvious build treats a 2% move as a 2% move. But a 2% day in a large-cap bank is a genuine
event, while a 2% day in a volatile small-cap is Tuesday. **Significance is relative, not
absolute** — so Radar normalises every move against *that stock's own* recent volatility.

Here are two stocks from the same watchlist, on the real session this repo ships with:

| Stock | Day move | Its own 30-day σ | z-score | Digest |
|---|---|---|---|---|
| PAYTM | **+1.97%** | 2.81%/day | 0.70σ | stayed silent |
| HDFCBANK | **+1.30%** | 0.91%/day | **1.44σ** | scored 2× higher |

PAYTM moved **50% further than HDFCBANK and mattered half as much**, because a 2% day is
routine for PAYTM and notable for HDFCBANK. No fixed-percentage threshold can express that.
A per-stock z-score can, and that single decision is worth more than five features.

Regenerate that table yourself against the shipped data:

```bash
npm run explain
```

It prints every watchlist symbol sorted by **raw percentage move** — and the surfaced/silent
verdict deliberately does not follow that ordering. The mismatch is the whole argument.

PAYTM still appears in the digest — but as *"up 14.9% since you added it at ₹1442"*. A different
question, honestly answered differently.

---

## 2. What counts as a meaningful change

Six detectors, each a pure function of `(history, quote, checkpoint)` with zero I/O.
They live in [`apps/server/src/significance/`](apps/server/src/significance/) — about 360 lines
you can read in one sitting.

| Event | Fires when | Base weight |
|---|---|---|
| `VOLATILITY_MOVE` | move since checkpoint ≥ **1.5σ** of the stock's own 30-day daily-return σ | z × 2.0 |
| `VOLUME_SPIKE` | day volume ≥ 2.5× its 20-day average | ratio × 1.2 |
| `BREACH_52W` | crosses a 52-week high/low **since the checkpoint** | 3.0 flat |
| `GAP_OPEN` | open vs previous close ≥ 1.5σ | gap-z × 1.5 |
| `STREAK` | ≥ 4 consecutive sessions in one direction | 0.6 × days |
| `REF_DRAWDOWN` | ±10% vs the price **when you added it** — personal, not market-wide | 2.0 flat |

### Ranking is an attention budget, not a sort

```
score = base_weight × recency_decay(occurred_at) × novelty(symbol)
```

- **Recency** halves every 24h. A 3σ move yesterday outranks a 3σ move last Tuesday.
- **Novelty** multiplies by 0.7 per recent appearance, so one permanently jumpy stock cannot
  monopolise the digest and train you to ignore it.
- **Top 5 only.** Everything else collapses into one row: *"Nothing unusual in 11 other stocks."*
- Below a global threshold the digest renders its **empty state**: *"Quiet since you left."*

A card ranks on its **best** event, not the sum of its events — summing lets five weak signals
outrank one important one, and a big move usually drags volume and streak along with it, so
summing double-counts a single story.

### You can inspect the judgment, and tune it

Three things follow from taking "explainable" seriously:

- **Sensitivity control.** The attention threshold is on screen, not buried — *Everything /
  Balanced / Only the big stuff*. Most products hide this number; exposing it lets you set
  your own tolerance instead of inheriting ours.
- **"Why silent?"** Expand the collapsed row and every quiet stock shows its move, its own σ,
  and the resulting z-score. Any watchlist can *claim* nothing important happened. This one
  shows the arithmetic — and it is the clearest possible demonstration of the thesis, because
  you can read a bigger % move sitting below a smaller one and see exactly why.
- **Visit history.** The checkpoints themselves are browsable, so the "memory" is visible
  rather than an internal implementation detail.

### Two rules the whole product hangs on

**Every surfaced event must explain itself in plain English, with its numbers.**
No unexplained badges, no black-box "AI score":

> *"IDEA rose 3.9% — a 1.7σ move against its own 30-day norm of ±2.3% a day."*

**A detector that cannot be confident stays silent.** Fewer than 6 daily bars, zero variance, a
suspended stock — every detector returns `null` rather than a fabricated number. A made-up
z-score is worse than silence, because the user cannot tell the difference.

---

## 3. Architecture

A **modular monolith**: one deployable backend with sharply separated internal modules. At this
scale, network boundaries between these modules would add failure modes without adding value.
The boundaries are drawn exactly where services would be cut later.

```
                    Browser (React + Vite)
                      │            ▲
              REST    │            │  SSE (live + replay ticks)
                      ▼            │
    ┌─────────────────────────────────────────────────┐
    │  API layer — auth · watchlists · digest · SSE    │
    └──────┬──────────────────────────────┬───────────┘
           │                              │
           ▼                              ▼
    ┌──────────────┐              ┌──────────────────┐
    │ Digest       │◄─────────────│ Significance     │
    │ diff + rank  │              │ Engine (PURE)    │
    └──────┬───────┘              └──────────────────┘
           │                              ▲
           ▼                              │
    ┌─────────────────────────────────────┴───────────┐
    │  Storage — SQLite (WAL)                          │
    │  users · watchlists · checkpoints · quotes ·     │
    │  daily_bars · events                             │
    └─────────────────────────────────────▲───────────┘
                                          │
    ┌─────────────────────────────────────┴───────────┐
    │  Ingestion — adapter chain, circuit breakers,    │
    │  AIMD pacing, staleness tags, monotonic guard    │
    └──────┬──────────────────────┬───────────────────┘
           │                      │
      ┌────▼─────┐          ┌─────▼──────┐      ┌──────────────┐
      │ BSE      │          │ Yahoo v8   │      │ Replay engine│
      │ (primary)│          │ (fallback) │      │ (recorded)   │
      └──────────┘          └────────────┘      └──────┬───────┘
                                                       │
                            replayed ticks re-enter ───┘
                            the SAME pipeline
```

| Module | Responsibility | Key decision |
|---|---|---|
| `ingestion/` | fetch, normalise, tag every quote with `source` + `fetchedAt` + `asOf` | adapter interface quarantines each provider's quirks |
| `significance/` | `(history, quote, checkpoint) → scored events`. Zero I/O | pure ⇒ trivially testable and replayable |
| `digest/` | `diff(now, checkpoint)`, rank, compress to top-N | computed **at read time**, never precomputed per user |
| `api/` | REST for CRUD, SSE for pushes | SSE over WebSockets — one-way data, free reconnection |
| `replay/` | recorded/synthetic tick playback | **same code path as live**, so the demo proves the real system |

**Core abstraction: the checkpoint.** A snapshot of exactly what you last saw, written when you
sign out or hit "Mark caught up". Everything interesting is `diff(now, checkpoint)`.

---

## 4. Why the market being closed is a feature

The judging window is Fri 11:00 → Mon 11:00. NSE closes Friday 15:30 and reopens Monday 09:15,
so for **~65 of those 72 hours live prices do not move**. A naive live-price watchlist demos as
a dead screen.

So we recorded the market instead:

```
23,154 quote rows · 60 NSE symbols
22,435 intraday ticks — 09:15:59 → 15:33:25 IST, Friday 4 Sep 2026
 3,942 daily bars   — 2025-09-04 → 2026-09-04, all 60 symbols
```

**Replay mode** plays that session back at 1×–600× through the same ingestion → SSE → digest
path live data takes. Watch the digest re-rank mid-replay and you are watching the real engine,
not an animation — which is the point. A scripted demo mode would only prove we can write a
scripted demo mode.

Replayed rows are written under `source='replay'` so the recorded tape stays pristine and Reset
is a single `DELETE`. **They are labelled `REPLAY`, never `LIVE`** — see the failure table below.

The database ships **in the repo**. Clone it on Sunday at midnight and the hero moment still works.

---

## 5. Never lie about data

Every price on screen carries its own age. `as_of` (when the price was true in the market) and
`fetched_at` (when we received it) are stored **separately** — their difference *is* the
staleness story.

| Chip | Meaning |
|---|---|
| `LIVE · 12s ago` | market open, data fresh within 60s |
| `DELAYED · 4m ago` | market open, data older than 60s |
| `STALE` | older than 15 minutes |
| `MARKET CLOSED` | exchange shut — showing the last close |
| `REPLAY` | **a replayed tick, not live market data** |

That last row was a bug we caught on screen. Replayed ticks were rendering as `LIVE · 0s ago` —
*technically true*, since we had generated them a moment earlier, and materially misleading.
Honesty about provenance has to survive your own features.

---

## 6. Failure modes

| Failure | Behaviour | Mechanism |
|---|---|---|
| Primary provider down | serve cached quotes, badge `DELAYED`, keep digesting on history | circuit breaker + last-known-good |
| Provider rate-limits us | back off multiplicatively and **stop asking** | AIMD + per-provider breaker |
| Provider returns malformed HTTP | tolerated inside that one adapter only | `insecureHTTPParser` scoped to BSE |
| Duplicate event computed twice | second insert is a no-op | `UNIQUE(dedup_key)` |
| Add the same symbol twice | 200 with the existing row, never a 500 | `UNIQUE(watchlist_id, symbol)` |
| Two devices edit one watchlist | 409 **plus the current state to merge** | optimistic concurrency via `version` |
| Out-of-order tick delivery | older tick dropped, UI never flaps backwards | monotonic `as_of` guard |
| **Two providers disagree** | fresher wins; if simultaneous and within 0.5%, hold (spread, not news); if simultaneous and further apart, **hold the last confirmed price, flag `unconfirmed`, re-poll** | `conflict.ts`, surfaced in the digest |
| Replay data outlives its process | stranded rows cleared at boot; replay never writes to event history | replay is read-only w.r.t. real state |
| Checkpoint races a quote write | snapshot is internally consistent | single transaction |
| Server crashes mid-digest | nothing corrupts — recompute | digests are pure functions of stored state |
| Weekend / clock skew | "since Friday's close", not "0% in 65 hours" | market-calendar-aware diffing |
| Two tabs, one marks caught up | the other refreshes its digest | SSE broadcast |

**On rate limits, measured rather than assumed.** Yahoo allows a burst of ~5 requests then
refills ~1/minute — and **429 responses themselves extend the penalty**, so a client that keeps
polling through them never recovers. That is why backoff is multiplicative and why the breaker
matters: a naive client digs its own hole deeper forever. We know because ours did, for 45
minutes, before we fixed it.

---

## 7. How this scales

The argument is numerical, not architectural buzzwords.

**Fetch dedup is the whole game.** 10,000 users watching stocks drawn from a ~2,000-symbol NSE
universe means quote fetching scales with **the symbol universe, not with users**. One scheduler
fetch per symbol per interval, shared by everyone. 10 users and 10,000 users cause identical
outbound load. This falls out of the architecture for free.

**Daily history scales by day, not by symbol.** We load NSE's official bhavcopy: one file per
trading day containing every listed symbol. 45 sessions of history for 60 symbols cost **45
requests, in 40 seconds**. The same 45 requests would cover all ~2,000 NSE symbols — the cost is
independent of universe size. (Per-symbol history APIs cost 60 requests for 60 symbols; under a
rate limit that is the difference between 40 seconds and never finishing.)

**Digests are computed at read time.** Users are absent most of the time, and computing digests
for absent users is work nobody reads. Cache for 30s to absorb refresh-spam.

**The engine itself is free.** Pure CPU over ~30 floats per symbol — microseconds. The bottleneck
is I/O, which fetch dedup already minimises.

**Named but not built:** in-process TTL cache → Redis at ~50k users (one swap behind the cache
interface); ~10k idle SSE connections per node is fine, beyond that sticky load-balancing plus a
pub/sub bus. These are seams, not implementations, and saying so is the honest answer.

---

## 8. Deliberately out of scope

- **Buy/sell or portfolio tracking** — this is a watchlist problem; scope creep dilutes the thesis.
- **LLM news/sentiment** — flashy, unreliable in 72h, and off-thesis. Every number here is
  auditable arithmetic; an LLM score would be the black box this product argues against.
- **Native mobile apps** — responsive web is enough.
- **Microservices, Kafka, Kubernetes** — rejected explicitly. No Kubernetes for 10 users.
- **Postgres** — the schema is written Postgres-portable (epoch-millis integers, TEXT for JSON,
  no SQLite-only types) so it is a driver swap. SQLite ships because a judge reaching the hero
  moment in 60 seconds is worth more than concurrency headroom a single node will not use.

---

## 9. Tests

```
114 tests · 8 files
```

The judgment core is tested deeply, not everything shallowly.

| File | What it defends |
|---|---|
| `significance/stats.test.ts` | volatility math + every degenerate input |
| `significance/detectors.test.ts` | all 6 detectors, and the thesis itself |
| `significance/score.test.ts` | ranking, recency decay, attention budget |
| `digest/build.test.ts` | **integration** — real SQLite, no mocks |
| `ingestion/resilience.test.ts` | circuit breaker, AIMD, timestamp parsing |
| `ingestion/marketCalendar.test.ts` | weekend/holiday anchoring |
| `ingestion/conflict.test.ts` | provider disagreement, the unconfirmed flag |
| `replay/synthetic.test.ts` | determinism, GBM calibration |

The thesis is an executable assertion, not a claim:

```ts
it('THE THESIS: an identical % move fires for a calm stock and not for a wild one', () => {
  const move = { prevClose: 100, price: 103 };            // +3% for BOTH
  expect(detectVolatilityMove(calmStock)).not.toBeNull();  // ~3σ — a genuine event
  expect(detectVolatilityMove(wildStock)).toBeNull();      // ~0.3σ — an ordinary day
});
```

And its inverse: **+2% surfaces while +8% stays silent.**

Degenerate inputs each get a test — zero-variance stock, two bars of history, missing volume,
junk timestamps — and in every case the assertion is that the detector returns `null` rather
than a number it cannot justify.

---

## 10. Project layout

```
radar/
├── apps/server/src/
│   ├── ingestion/      adapters (BSE, Yahoo), scheduler, circuit breaker,
│   │                   AIMD pacing, conflict policy, bhavcopy, market calendar
│   ├── significance/   PURE detectors + scoring  ← the heart, ~360 lines
│   ├── digest/         diff + rank + compress, event log, 30s cache
│   ├── replay/         recorded playback + synthetic GBM generator
│   ├── api/            routes, auth, SSE hub, optimistic concurrency
│   ├── db/             schema + additive migrations
│   └── cli/            seed · tape · bhavcopy · symbols · explain
├── apps/web/src/       React UI — digest, live table, drill-down, replay
├── DECISIONS.md        dated trade-offs ← read this one
├── docker-compose.yml
└── README.md
```

**[`DECISIONS.md`](DECISIONS.md)** is the companion to this file: 25 dated entries recording what
was chosen, what was rejected, and why. Most are backed by something we actually measured or a
bug we actually hit.

---

## 11. Data sources

| Source | Role | Notes |
|---|---|---|
| **BSE India** | primary live quotes | no auth, ~1.6 req/s sustained |
| **NSE bhavcopy** | daily OHLCV history | one file per session, every listed symbol |
| **Yahoo v8 chart** | fallback quotes | severe rate limit; kept to exercise the fallback chain |

Two providers is not decoration. BSE and NSE are **different exchanges**, so the same company
genuinely carries two slightly different prices at the same instant. That real disagreement is
what the conflict policy in [`ingestion/conflict.ts`](apps/server/src/ingestion/conflict.ts)
resolves — see [§6](#6-failure-modes).

Endpoints were probed before anything was built against them, which is how we learned that
Yahoo's `v7/quote` and `v10/quoteSummary` — the endpoints most tutorials use — now return 401.
