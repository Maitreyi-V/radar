# DECISIONS.md

A dated log of every meaningful trade-off: what we chose, what we rejected, and why.
Newest entries at the bottom. Every entry is something we can defend out loud.

---

### D1 — 2026-09-04 · Modular monolith, not microservices
**Chose:** one deployable Node/Fastify backend with hard internal module boundaries
(`ingestion/`, `significance/`, `digest/`, `replay/`, `api/`).
**Rejected:** separate services per module; Kafka; Kubernetes.
**Why:** at this scale a network hop between modules adds failure modes (partial failure,
retries, serialization, deploy ordering) and buys nothing. The module boundaries are drawn
exactly where we *would* cut services later, so the refactor stays cheap. Over-engineering
for 10 users is a negative signal, not a positive one.

---

### D2 — 2026-09-04 · SQLite as the default store, Postgres-portable schema
**Chose:** SQLite (better-sqlite3) in WAL mode as the shipped default.
**Rejected:** requiring Postgres/Docker to run the project.
**Why:** a judge must reach the hero moment in under 60 seconds. `npm install && npm run dev`
with zero external services is worth more than theoretical concurrency headroom for a
single-node app. The schema is deliberately written Postgres-portable — epoch-millis
INTEGER timestamps, TEXT for JSON (JSONB in PG), no SQLite-only types — so the migration is
a driver swap, not a rewrite. WAL mode gives us concurrent readers while the scheduler writes.

---

### D3 — 2026-09-04 · Yahoo v8 `chart` endpoint (the others are dead)
**Chose:** `query1.finance.yahoo.com/v8/finance/chart/{symbol}`.
**Rejected:** `v7/finance/quote` and `v10/quoteSummary` — the endpoints most tutorials use.
**Why:** verified empirically at H0 — both now return **HTTP 401** without an authenticated
crumb. v8 `chart` is the only one still reachable unauthenticated. Probing the provider
*before* writing the adapter saved building against a dead API.
**Two field traps found by inspecting the real payload rather than assuming:**
- `meta.previousClose` is `null` → must use `meta.chartPreviousClose` (else GAP_OPEN breaks)
- `meta.regularMarketOpen` is `null` → the open only exists at `indicators.quote[0].open[0]`

---

### D4 — 2026-09-04 · Migrate at DB-open, not from the entrypoint
**Chose:** `migrate()` runs as a side effect of opening the database in `db/index.ts`.
**Rejected:** calling `migrate()` first thing in `main()`.
**Why:** we hit this as a real bug. Modules like `store.ts` call `db.prepare(...)` at module
top level, and ESM fully evaluates every import *before* the importing module's body runs —
so `migrate()` in `main()` is always too late and every prepare throws `no such table`.
The schema is `CREATE TABLE IF NOT EXISTS` throughout, so open-time migration is idempotent
and costs ~1ms. Ordering bug eliminated by construction rather than by remembering to call
things in the right order.

---

### D5 — 2026-09-04 · Pace the provider; don't parallelise it
**Chose:** a shared token bucket (~3 req/s sustained, burst 4) with **sequential** fetching,
plus full-jitter exponential backoff retried only on 429/5xx.
**Rejected:** concurrency-4 fan-out, which is the obvious way to "speed up" the poll cycle.
**Why:** measured, not guessed. 60 symbols at concurrency 4 with no pacing → **HTTP 429 on
every single request**. The identical 60 symbols issued sequentially at a ~300ms gap → 100%
success, including heavy `range=1y` payloads. Yahoo throttles on **burst/concurrency**, not
sustained volume, so the fix is pacing rather than backing off. A 404 is a bad symbol and is
deliberately *not* retried — retrying non-transient errors just wastes the budget.
**Consequence:** ~60 symbols × ~300ms ≈ 18s per cycle, so the poll interval is 30s.

---

### D6 — 2026-09-04 · Store `as_of` and `fetched_at` separately
**Chose:** every quote row carries both the exchange timestamp and our receive timestamp.
**Rejected:** a single `timestamp` column.
**Why:** the difference between them *is* the staleness story, and it is the only honest way
to render "LIVE · 12s ago" vs "DELAYED" vs "MARKET CLOSED". A watchlist that shows a stale
price with no age is lying to the user. Surfacing data age instead of hiding it is a
deliberate product stance, and it makes the degraded state demo-able.

---

### D7 — 2026-09-04 · Monotonic guard on quote writes
**Chose:** drop any incoming tick whose `as_of` is older than the newest stored `as_of`
for that (symbol, source).
**Why:** providers deliver out of order under retries and load balancing. Without the guard
the UI flaps backwards in time and the diff engine sees phantom reversals that never
happened in the market. Combined with `UNIQUE(symbol, as_of, source)`, re-ingesting the same
tick is a no-op, so the pipeline is safely replayable.

---

### D8 — 2026-09-04 · Idempotency enforced by the database, not by application code
**Chose:** `UNIQUE(watchlist_id, symbol)` on items and `UNIQUE(dedup_key)` on events.
**Rejected:** check-then-insert in application code.
**Why:** check-then-insert has a race window; a constraint does not. Double-tapping "Add"
returns 200 with the existing row instead of a 500 or a duplicate, and an event like
`TCS:BREACH_52W:2026-09-04` physically cannot be recorded twice no matter how many code
paths compute it.

---

### D9 — 2026-09-04 · Anchor diffs to trading sessions, not wall-clock
**Chose:** a market-calendar module (IST, 09:15–15:30, weekends + NSE holidays).
**Why:** the judging window is Fri 11:00 → Mon 11:00, so ~65 of 72 hours are market-closed.
Wall-clock diffing would tell a user "0.0% change over 65 hours", which is technically true
and completely useless. Anchoring to "since Friday's close" is the only phrasing that means
anything over a weekend.

---

### D10 — 2026-09-04 · AIMD pacing instead of a hardcoded rate
**Chose:** Additive-Increase / Multiplicative-Decrease pacing — success shortens the
interval by a small step, a 429 doubles it — with strictly **one in-flight request**.
**Rejected:** a fixed "safe" interval; parallel fetching.
**Why:** the provider's real limit is undocumented and moves. Measured behaviour:
burst ~5 requests, refill ~1/min, and — the property that actually matters — **the
penalty escalates: 429 responses themselves extend the lockout.** A client that keeps
polling through 429s never recovers, which is exactly what our first recorder did.
AIMD is the same control law TCP uses, for the same reason: probe for an unknown limit,
retreat hard when you find it. Multiplicative decrease isn't just politeness here, it's
the only way out of the penalty box.

---

### D11 — 2026-09-04 · Spend the live budget on live data only
**Chose:** during market hours, 100% of the request budget goes to live quotes for a
prioritised 15-symbol demo watchlist. Daily-bar backfill is a separate script
(`npm run backfill`) intended for the weekend.
**Rejected:** the obvious ordering — backfill history first, then start recording.
**Why:** daily bars are *historical*; they are equally available on Sunday. Intraday
ticks exist only while the market is open and can never be recovered. Our first recorder
spent its entire budget backfilling history during the one window when history was the
cheap thing to get. Under a scarce budget, prioritise by **what expires**, not by what
comes first in the pipeline.

---

### D12 — 2026-09-04 · Detectors return null instead of guessing
**Chose:** every detector returns `null` when the data cannot support a confident answer
(fewer than 6 daily bars, zero variance, missing volume).
**Rejected:** falling back to a default sigma or a fixed % threshold.
**Why:** the product's entire claim is that its signals are trustworthy and explainable.
A fabricated z-score computed from a made-up sigma is worse than silence, because the
user cannot tell the difference. Staying quiet is honest; guessing is not. This is also
why the empty state is a feature rather than a failure.

---

### D13 — 2026-09-04 · Card score is its best event, not the sum of its events
**Chose:** a symbol's rank = the score of its single highest-scoring event.
**Rejected:** summing all event scores for that symbol.
**Why:** summing lets five mediocre signals outrank one genuinely important one, which
inverts the whole point of an attention budget. It also biases toward stocks that trip
many correlated detectors at once (a big move usually drags volume and streak with it),
double-counting one underlying story.

---

### D14 — 2026-09-04 · BSE as the primary provider, Yahoo demoted to fallback
**Chose:** BSE India's public quote API (`api.bseindia.com`) as provider #1; Yahoo v8 as
provider #2 and the source of daily bars.
**Rejected:** Yahoo as primary (its rate limit makes a live poll impossible); NSE's own
API (returns **403** from our network); Stooq (no Indian equity coverage).
**Why:** measured — BSE served 18/18 requests at ~1.6 req/s with zero failures, while
Yahoo allows a burst of ~5 then ~1/min. One request to BSE's scrip master returns ~5,000
active equities with ticker, scripcode and market cap, which also answers "how would you
load the full universe?" — it is bulk data, not per-symbol lookups. **60/60** of our
symbols mapped, the two misses being genuine corporate actions (Tata Motors' demerger,
Zomato → Eternal Ltd), which are recorded as documented overrides rather than silent patches.
**Bonus that matters:** BSE and NSE are *different exchanges*, so the same company really
does carry two slightly different prices at the same instant. Our conflict policy is now
exercised by real disagreement instead of a simulated one.

---

### D15 — 2026-09-04 · A lenient HTTP parser, scoped to one adapter
**Chose:** `node:https` with `insecureHTTPParser: true` for the BSE adapter only.
**Rejected:** global `fetch()` for that provider; disabling strict parsing process-wide.
**Why:** BSE's edge intermittently emits a non-RFC-compliant response header
("Unexpected whitespace after header value"). Node's undici parser — which backs global
`fetch()` — rejects it, failing roughly 1 request in 3. `node:https` accepts the lenient
parser: **18/18 succeeded**. The important part is the blast radius: the looseness lives
inside the one adapter that needs it and is invisible to everything downstream. This is
exactly the job the ProviderAdapter interface exists to do — quarantine a provider's
quirks so they never become the system's quirks.

---

### D16 — 2026-09-04 · Per-provider pacing, not one global rate
**Chose:** each provider owns its own circuit breaker and its own AIMD controller.
**Rejected:** a single shared rate limiter across the chain.
**Why:** their sustainable rates differ by roughly two orders of magnitude (BSE ~1.6/s,
Yahoo ~1/min). One global rate would either crawl everything at Yahoo's pace or hammer
Yahoo at BSE's. Rate limits are a property of the provider, so the state belongs with
the provider.

---

### D17 — 2026-09-04 · Back-fill sparse fields from their last non-null observation
**Chose:** the "latest quote" query takes price and timestamp from the newest row, but
carries volume, the 52-week range and the OHLC levels forward from the most recent row
that actually contains each one.
**Rejected:** simply selecting the single newest row per symbol.
**Why:** caught as a real bug on screen — every volume rendered as "—". Different
providers populate different fields: BSE's quote endpoint returns a fast price but no
volume, while the intraday-tape rows carry both. Whenever a quote tick was newer than
the last tape row, it *shadowed* the only row that had the volume. Volume is cumulative
and the 52w range is a slow-moving level, so the last known value is the correct value —
this is carrying data forward, not inventing it. A field nobody has ever reported still
renders as "—".

---

### D18 — 2026-09-04 · The sparkline covers the same window as the number beside it
**Chose:** sparkline samples the whole trading session and takes its colour from the day
change.
**Rejected:** the last N ticks, coloured by first-vs-last of that window.
**Why:** also caught on screen — HDFCBANK displayed "+1.56%" next to a red, falling line.
Both were individually correct (up on the day, down over the last 40 minutes) and together
they misinformed. When a chart and a number sit in the same row, users read them as one
statement, so they must describe the same window.

---

### D19 — 2026-09-04 · Demo checkpoint anchored to the real 09:15 open
**Chose:** the seeded account's checkpoint is backdated to the first recorded tick of the
session, with `ref_price` set to that morning's price.
**Rejected:** seeding a checkpoint at "now", or hand-writing fixture events.
**Why:** the hero moment is "what changed since you last looked", and an account created
five seconds ago has nothing to diff against. Anchoring to 09:15 means the digest reports
genuine intraday moves computed by the real engine over the real recorded tape. Nothing
in the demo path is a fixture — a judge can add their own symbol and get the same
treatment.

---

### D20 — 2026-09-04 · Daily history from NSE bhavcopy, not per-symbol APIs
**Chose:** `nsearchives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv` —
the exchange's official end-of-day file, one per trading day, containing OHLC and volume
for every listed symbol (~2,600 EQ rows).
**Rejected:** per-symbol history calls to Yahoo.
**Why:** the cost model inverts. Yahoo bills one request PER SYMBOL, so 60 symbols is 60
requests — and under its rate limit it delivered **0 symbols in 45 minutes**, pinned at
maximum backoff. Bhavcopy bills one request PER DAY, so 45 sessions of history for the
whole universe is 45 requests: **completed in 40 seconds with zero failures, 60/60
symbols**. The same 45 requests would cover all ~2,000 NSE symbols, so this is also the
honest answer to "how does it scale to the full universe".
Two further wins: it is the exchange's own record rather than a third party's
reconstruction of it, and the static archive host serves us even though
`nseindia.com/api` returns 403.
**Lesson worth stating out loud:** when a rate limit blocks you, look for an endpoint with
a different unit of work before optimising your request pacing against the wrong one.

---

### D21 — 2026-09-04 · Corporate-action aliases, resolved by evidence
**Chose:** an explicit dated alias map (`TATAMOTORS.NS -> TMCV`, `ZOMATO.NS -> ETERNAL`)
rather than renaming our internal symbols.
**Why:** renaming would orphan the recorded Friday tape, which is keyed on the internal
names and cannot be re-recorded. The Tata Motors mapping was resolved by **price
cross-check rather than assumption**: post-demerger both TMCV and TMPV exist, and TMCV
closed at ₹460.35 against our live ₹459.00 while TMPV was at ₹312.00 — so our symbol
tracks TMCV. The reasoning is recorded in the code beside the map, because a future
reader cannot re-derive it.

---

### D22 — 2026-09-04 · Anchor the demo checkpoint to the previous close
**Chose:** the seeded account's checkpoint is the previous session's official close, with
`ref_price` set to the close ~20 sessions earlier.
**Rejected:** checkpointing at "now" or at today's 09:15 open.
**Why:** discovered by looking at an underwhelming digest. With a 09:15 anchor the diff
window is about three hours, and almost nothing crosses 1.5 sigma in three hours — the
engine was right and the *question* was wrong. A user who checks their watchlist daily
last looked after yesterday's close, so that is the honest anchor; it yields 5 ranked
cards from 16 symbols. Both baselines come from recorded data (bhavcopy closes), so
nothing in the demo path is fabricated.

---

### D23 — 2026-09-04 · The thesis, measured on real data (for the README)
Real numbers from the Friday 4 Sep session, both stocks on the same watchlist:

| Stock    | Day move | Its own 30-day sigma | z-score | Digest        |
|----------|----------|----------------------|---------|---------------|
| HDFCBANK | +1.56%   | 0.91%/day            | 1.73σ   | **surfaced**  |
| PAYTM    | +2.65%   | 2.81%/day            | 0.94σ   | stayed silent |

PAYTM moved **70% further** than HDFCBANK and mattered less. No fixed-percentage rule can
express that; a per-stock z-score can. PAYTM still appeared in the digest — but as
"up 15.7% since you added it", a different question with a different answer.

---

### D24 — 2026-09-04 · Replay feeds the real pipeline, not a mock
**Chose:** the replay engine reads the recorded tape and pushes ticks through the same
`writeQuote` -> SSE -> significance -> digest path that live data takes.
**Rejected:** a scripted animation, or a separate "demo mode" rendering canned output.
**Why:** the judging window is Fri 11:00 -> Mon 11:00, so for ~65 of 72 hours the market
is shut and a live-price watchlist demos as a dead screen. Replay converts that from a
liability into the signature feature. Feeding the real pipeline means the demo *is*
evidence: watching the digest re-rank mid-replay proves the engine works, whereas a
scripted animation would prove only that we can write an animation. It doubles as a test
harness — a 6-hour session compresses to ~30 seconds at 600x.
**Implementation notes:** replayed rows are written under `source='replay'`, so the
recorded tape stays pristine and a reset is one DELETE. Ticks are stamped with wall-clock
now (the original market time is reported separately as the simulated clock), because
stamping them with their original past timestamps would trip the monotonic guard and be
correctly discarded.

---

### D25 — 2026-09-04 · A replayed tick is labelled REPLAY, never LIVE
**Chose:** a distinct `REPLAY` freshness state that outranks the age check.
**Rejected:** letting replayed ticks fall through to `LIVE`.
**Why:** caught on screen during the first replay demo — every row proudly said
`LIVE · 0s ago`. That was *technically true*: we had generated the tick a moment earlier,
so by data age it really was fresh. It was also materially misleading, because the user
would read it as live market data while the exchange was shut. This is exactly the class
of quiet lie the product exists to refuse, and it would have been indefensible if a judge
noticed it before we did. Honesty about data provenance has to survive our own features.

---

### D26 — 2026-09-04 · Renamed Pulse → Radar
Cosmetic, but recorded because it touched ~40 files, the DB filename, the session cookie and
the demo credentials. Note for anyone repeating it: macOS/BSD `sed` does not support `\b`
word boundaries, so the first pass silently missed `Pulse` at line starts. `perl -pi` with a
negative lookbehind finished the job without mangling Tailwind's `animate-pulse` class.

---

### D27 — 2026-09-04 · Conflict policy: hold the incumbent, flag the dispute
**Chose:** fresher quote wins outright (>5s); near-simultaneous and within 0.5% holds the
incumbent (that gap is exchange spread, not news); near-simultaneous and further apart holds
the last confirmed value, flags the symbol `unconfirmed`, and re-polls.
**Rejected:** taking whichever quote arrived last; averaging the two.
**Why:** BSE and NSE are different exchanges, so the same company legitimately carries two
prices at once. Last-write-wins makes the number FLAP between feeds and the user cannot tell
whether anything really moved. Averaging invents a price that neither exchange ever printed.
Holding a slightly stale but *real* price, and saying plainly that it is disputed, is the only
option that never shows a number nobody traded at.
**Honest note:** an earlier version of this README claimed the conflict policy existed when
only the fallback chain did. That was caught in a self-audit against the plan and is why this
entry exists — writing about a feature is not building it.

---

### D28 — 2026-09-04 · Persist events; a simulation must not write real history
**Chose:** detected events are written to `events` (UNIQUE(dedup_key) makes it idempotent),
**except** when the digest was built from replayed ticks.
**Why (first half):** the table existed with its dedup constraint, but nothing ever inserted
— so the idempotency the data model advertised was never exercised, and novelty damping had
no history to look at and silently always returned 1.0. Persisting fixes both, and gives the
drill-down a real event timeline. Verified in production: refetching a digest three times
leaves the event count unchanged.
**Why (second half):** this was discovered as a live bug. Replaying a recorded session wrote
6 phantom events into the user's real history, which then damped novelty for symbols that had
never actually moved — and the digest silently lost two genuine cards. A simulation that can
corrupt real state is not a simulation. Replay is now read-only with respect to event history.

---

### D29 — 2026-09-04 · Replay output must not outlive its process
**Chose:** clear all `source='replay'` rows at server startup.
**Why:** replayed ticks are written to the database so they travel the real read path, but the
engine's progress lives in memory. A restart therefore stranded thousands of replay rows with
no engine to own them: the UI kept rendering `REPLAY` prices while the engine reported `idle`,
and the Reset control — which only rendered while a replay was active — was unreachable. The
user was stuck looking at simulated data with no way back. State that spans two lifetimes
needs one owner; here the process is that owner.

---

### D30 — 2026-09-04 · Checkpoint on leaving, via sendBeacon
**Chose:** write a checkpoint on explicit "Mark caught up", on sign-out, and on tab-hide using
`navigator.sendBeacon`.
**Why:** the diff anchor should move whenever the user actually stops looking, not only when
they remember to press a button. A normal `fetch` is cancelled during unload — the browser
will not wait for it — so `sendBeacon` is the only reliable option. Best-effort by design: a
missed checkpoint costs a slightly older anchor, never data.

---

### D31 — 2026-09-04 · The monolith serves the frontend in production
**Chose:** in production the server also serves `apps/web/dist`, with an SPA fallback; in dev
Vite serves the UI and proxies `/api`.
**Why:** it makes `docker compose up` produce ONE container on ONE port with no nginx, no
separate static host and no CORS — which is the whole promise of the monolith decision, made
literal. API paths still return JSON 404s rather than falling through to `index.html`, so a
mistyped endpoint fails honestly instead of returning HTML with a 200.

---

### D32 — 2026-09-04 · Dwell guard on the auto-checkpoint
**Chose:** the tab-hide checkpoint only fires if the user stayed at least 30 seconds.
**Rejected:** checkpointing on every `visibilitychange`.
**Why:** caught while screenshotting. `visibilitychange` fires on every tab flick, window
switch and minimise — so a two-second glance silently moved the diff anchor, and the next
visit showed "nothing changed" for someone who had never read what changed. **Marking a user
caught up on something they did not read is the one failure this product cannot afford**: the
whole promise is that it remembers what you saw. It also made the demo fragile, since a judge
tabbing away would erase the hero moment. Thirty seconds distinguishes a glance from a visit.

---

### D33 — 2026-09-04 · Search the whole market, poll a curated universe
**Chose:** import the FULL BSE active-equity master (~5,000 rows) into `symbols`, flagged
`tracked = 1` for the 60 we poll on a schedule and hold recorded tape for. Any symbol can be
searched and added; symbols outside the universe get their quote fetched **on demand**.
**Rejected:** importing only the 60 symbols we poll.
**Why:** found as a user-reported bug, and it was the right kind of embarrassing. The search
box reads this table, so importing only the polled universe made every other Indian stock
un-findable — searching "DMART", "TRENT" or "LICI" returned an empty dropdown, and the honest
conclusion was that adding stocks was broken. **The universe should govern what we POLL, never
what you can LOOK UP**; I had conflated a scheduling concern with a discovery one.
Verified: DMART now resolves, adds, and gets a live price (₹3,770) fetched on demand.
**Consequence for the scale story:** fetching still scales with the symbol universe rather than
with users — the on-demand path is one request the first time a symbol is added, after which
it is shared like any other.

---

### D34 — 2026-09-04 · The digest cache must not outlive the facts it summarises
**Chose:** the replay UI refreshes with `fresh=1`, bypassing the 30s digest cache.
**Why:** caught in a screenshot. The replay bar advanced — market clock ticking, thousands of
ticks replayed — while the digest cards sat frozen showing `MARKET CLOSED`, because the cached
digest was still valid by wall-clock TTL. The API was correct the whole time; only the browser
looked broken, which is worse, because that is what a judge sees. A 30s TTL is right for a
returning user hammering refresh and wrong when the underlying market changes many times a
second. The cache is now opt-out for the one caller that genuinely needs live recomputation.

---

### D35 — 2026-09-04 · Say what it means, not what it measures
**Chose:** all user-facing copy is plain English. "1.6× its usual daily move" instead of
"a 1.6σ move"; "a quiet day for this stock" instead of "1.31σ — below the 1.5 threshold".
The σ and z columns are one click away behind **show the math**, and remain in the API payload.
**Rejected:** surfacing z-scores and σ directly, which is what the first version shipped.
**Why:** a user pointed at the quiet panel and said, correctly, that nobody outside finance
knows what a z-score is. They were right, and it undercut the product's central claim: an
explanation that requires a statistics background is not an explanation, it is a different
kind of black box. The fix is not to dumb the engine down — the maths is unchanged — but to
translate at the boundary. A z-score of 1.6 *means* "1.6× a normal day", so we write that.
**Kept deliberately:** the technical view, because the rigour is a real asset when someone
asks how the ranking works. Two audiences, one number, progressive disclosure.
**Test enforces it:** detector explanations now assert they contain no `σ`, `z-score`, or
"standard deviation" — jargon cannot silently creep back into user-facing copy.

---

### D36 — 2026-09-04 · Store the whole bhavcopy, not a filtered slice
**Chose:** import every EQ row from each bhavcopy file — 112,624 bars across 2,748 symbols.
**Rejected:** the original behaviour, which parsed the whole file and then kept only the 60
symbols in the curated universe.
**Why:** filtering saved nothing. The file was already downloaded and parsed; discarding 97%
of it only guaranteed that any stock a user added outside the universe had no history, so the
detectors honestly refused to judge it ("we don't have enough history for this stock yet").
Since a user can add any of ~5,000 listed symbols, the history has to cover them too.
**Cost:** the same 45 requests — widening to the whole market cost zero extra network calls.
On disk it took the database from 4.8 MB to 15 MB, which is a good trade for making every
listed stock work, and still trivial to clone.
**Verified:** added DMART, TRENT and HAVELLS — none ever in the universe. HAVELLS surfaced a
card ("fell 3.7% — 3.2× its usual daily move"), the other two got real plain-English verdicts,
and nothing landed in `unavailable`.

---

### D37 — 2026-09-05 · Recency decays in TRADING time, not wall-clock
**Chose:** `recencyDecay` measures age as elapsed **trading** milliseconds — weekends,
holidays and overnight gaps contribute zero — with a half-life of one session.
**Rejected:** the original wall-clock half-life of 24h.
**Why:** caught while verifying the Docker image, one day after the recorded session. The
digest had gone **completely empty**. Wall-clock decay was burying genuine Friday events over
a weekend in which the market never opened:

| When | Wall-clock decay | IDEA (base 3.2) |
|---|---|---|
| Fri, at the close | 0.998 | 3.19 ✓ |
| Sun 6 Sep | 0.236 | 0.76 ✗ vanished |
| Mon 7 Sep 11:00 (deadline) | 0.142 | 0.46 ✗ vanished |

Every judge opening the submission would have seen "Quiet since you left" — the honest empty
state, firing dishonestly, because the arithmetic was measuring the wrong thing.

The fix is the same principle already established in D9: **for a market product, elapsed time
means elapsed TRADING time.** A 3-sigma move on Friday afternoon is still the most recent thing
that has happened when you open the app on Sunday, because nothing has traded since. With the
fix, that event holds 3.20 all weekend and only begins decaying when Monday's session opens.
**Verified end to end:** the same three cards render on Saturday that rendered on Friday.

---

### D38 — 2026-09-05 · Multi-stage image; compile, don't ship a TypeScript loader
**Chose:** a builder stage with the toolchain that compiles the server to plain JS and bundles
the frontend, then a runtime stage carrying only pruned `node_modules` and built output.
**Result:** **1.14 GB → 466 MB**, and the container boots with `node dist/index.js` instead of
a TypeScript loader.
**Why:** the single-stage image shipped python3, make, g++ and every dev dependency into
production — none of which run anything. On a free hosting tier that is the difference between
a build that completes and one that times out.

---

### D39 — 2026-09-05 · Cache prepared statements (a hard crash, found only in the container)
**Chose:** memoise `db.prepare()` by SQL text at the point the database is opened.
**Why:** the containerised build died with **exit 133** whenever a replay started:

```
node[1]: void node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
Assertion failed: (env) != nullptr
```

better-sqlite3 expects statements to be prepared once and reused. About 30 call sites prepared
inside the function instead, so replay — thousands of statement creations a second — produced
enough garbage Statement objects that their native destructors ran during teardown and
tripped an assertion in Node itself. Not a JavaScript exception: an immediate process abort.
**Fixed at one point rather than thirty.** Hand-editing every call site would have worked and
then decayed, because nothing would stop the next `db.prepare()` inside a handler. Installing
the cache on the database means every caller — including future ones — gets reuse for free,
and it is strictly faster besides. Safe here because nothing mutates statement state
(`.pluck()`, `.raw()`, `.bind()`), which is the one thing that would make sharing unsound.
**Only reproducible in the container**, under sustained load, which is exactly why building
and running the image before deploying was worth the time.

---

### D40 — 2026-09-05 · better-sqlite3 11 → 13 (the deploy failure)
**Chose:** upgrade `better-sqlite3` from 11.10.0 to 13.0.3.
**Why:** the first Render deploy failed, and reproducing it locally on **linux/amd64** — the
platform Render runs, versus the arm64 of a Mac — showed the process aborting at startup:

```
node[1]: void node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
Assertion failed: (env) != nullptr
```

better-sqlite3 11.x predates Node 24 and its native cleanup hooks are incompatible with it;
13.x declares `engines: node >= 22`. On arm64 the same mismatch only surfaced under replay
load, which is why it read as a statement-lifetime problem at first. The prepared-statement
cache from D39 is still right — reusing statements is what the library asks for, and it is
faster — but it was treating a symptom.
**Lesson:** build and run the actual production image on the actual production architecture
before deploying. `npm run dev` on a Mac passed every test while the container aborted on boot.

---

### D41 — 2026-09-05 · Derive the demo anchor from the data, not from today's date
**Chose:** the seed anchors its checkpoint to the session *before the most recent recorded
session in the database*, rather than "the previous calendar session".
**Why:** the old logic broke the moment the wall clock passed the recorded day. Our prices come
from Friday's tape; once it was Saturday, "the previous session" WAS Friday, so the digest
compared Friday against Friday, every move computed as 0.00%, and the hero moment quietly
emptied. Deriving the anchor from the data makes the demo identical whether a judge opens it
on Friday evening or Monday morning — which, given the judging window, is the whole point.
