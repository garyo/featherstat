# 04 — APIs

Four surfaces: Matomo-compatible tracking (the cutover contract), native
tracking, the batched query API (the performance contract), and realtime SSE.
All request/response shapes live as zod schemas in `packages/shared`.

## 1. Matomo-compatible tracking

### `GET|POST /matomo.php` (alias `/piwik.php`)

Accepts the parameter subset the tracked sites actually emit (plus the common
neighbors, so third-party Matomo SDKs mostly work). Unknown parameters are
ignored, never errors — a tracker must be impossible to break from the tag side.

| Matomo param | Meaning | Mapping |
| --- | --- | --- |
| `idsite` | site id | `site_id` (unknown id → 204, dropped; never 4xx to a browser beacon) |
| `rec=1` | "record this" | required, else ignored |
| `url` | page URL | split → `hostname`, `path` (query string kept, fragment dropped) |
| `action_name` | page title | `title`; with no `url` it still records a pageview (Matomo title-only actions) |
| `urlref` | referrer | attribution pipeline |
| `e_c`,`e_a`,`e_n`,`e_v` | event cat/action/name/value | `type='event'` + fields |
| `link` / `download` | outlink / download URL | `type='outlink'|'download'`, `target_url` |
| `ping=1` | heartbeat | `type='ping'` (session/engagement only) |
| `pv_id` | pageview id | accepted, ignored (sessions cover our model) |
| `res` | screen resolution | `screen` |
| `h`,`m`,`s`,`cdt` | client time | ignored — server clock is authoritative |
| `_id` | visitor id (16 hex) | replaces fingerprint input (see 03) |
| `uid` | site-provided user id | opt-in stable hash (see 03); ignored unless the site's `uid_enabled` setting is on |
| `cip` | client IP override (see 06, tee mode) | accepted and carried as `clientIpOverride`; deliberately inert until authenticated server-side senders exist — an unauthenticated override could spoof identity and geo |
| `lang` | language | fallback; `Accept-Language` header preferred |
| `rand`, `apiv`, `cookie`, `gt_ms` | noise | ignored |
| `send_image=0` | response style | **204 No Content** (the packzen webhook depends on this); otherwise 200 + 1×1 GIF |

Also honored: `POST` bodies in both form-encoded and Matomo's JSON bulk format
(`{"requests": ["?idsite=1&…", …]}`), because `sendBeacon` and SDKs use them.

Semantics: respond immediately after normalization; enrichment and storage are
asynchronous (see 02). Any parse failure inside a hit degrades to "record what
was understood" — beacons are fire-and-forget and must never bounce.

**Bot filtering vs server-side senders.** The pipeline drops hits whose
User-Agent matches the isbot list — which includes `curl` and `node`, so a
hand-rolled test hit needs a browser UA (drops are visible in the diagnostics
counter, and the endpoint still answers 200/204 — the drop is silent by
design). The packzen webhook passes today only because Workers `fetch` sends
no UA. That's fragile: WP13's authenticated server-side senders (bearer
token) bypass the bot check explicitly, and the bake-period reconciliation
(06) should compare the signup-event count against Matomo's to prove none
were lost.

### `GET /matomo.js` (alias `/piwik.js`)

A compatibility shim, **not** Matomo's 200 KB tracker — target < 3 KB gz. Ours
throughout: reimplementing the `_paq` interface is what keeps this MIT, where
vendoring Matomo's GPLv3 tracker would not.

It is a **migration path, not the way to start** — Settings offers the native
tag (§ 2) only, because the shim claims `window._paq` and therefore cannot run
beside a real Matomo tag while an operator compares the two (docs/06 § Already
running Matomo?).

It processes the standard `_paq` queue and implements exactly the used surface:

`trackPageView`, `trackEvent`, `trackLink`, `enableLinkTracking`,
`enableHeartBeatTimer`, `disableCookies` (no-op — always cookieless),
`setTrackerUrl`, `setSiteId`, `setCustomUrl`, `setDocumentTitle`,
`setReferrerUrl`.

Unknown `_paq` commands log one `console.debug` and are ignored. Delivery via
`navigator.sendBeacon` with fetch-keepalive fallback. Heartbeat: focus-gated
15 s ping, exactly like the tags expect. No SPA auto-tracking here — the blog
already re-pushes on `astro:page-load` and the shim must not double-count.

**One navigation is one page view (both trackers).** A `trackPageView` for the
same URL within **1 s** of the previous one is dropped client-side: SPA routers
announce a single route change from two places, and production measured the
pair 0–112 ms apart. Two guards, two problems — `browser.ts` stops a page that
*installs* matomo.js twice, this stops an app that *announces* twice; the shim
resolves the URL through `setCustomUrl` first, so an SPA route change is a
different view and passes. Deliberately not longer than a second, and the
reason is not tidiness: past the 30-minute session timeout a page view
legitimately **starts a new visit**, and a guard that swallowed it would leave
that visit holding heartbeats and nothing else — the pageview-less ghost visit
the sessionizer was fixed to stop producing. `packages/tracker/src/repeat.ts`
owns the rule; its test pins the window far below `SESSION_TIMEOUT_MS` and both
trackers assert the timeout case end to end. Events, outlinks, downloads and
pings are untouched. A suppressed hit is never sent, so invariant 4 (beacons
never bounce) is not in play: the collector refuses nothing.

**Leaving is a hit (both trackers).** Engagement accrues *between* hits — the
sessionizer credits each arrival with the gap since the last one, clamped at
`PING_CLAMP_MS` — so a session is only ever credited up to its **last** hit.
With a 15 s heartbeat and nothing sent at the end, every visit silently lost
its final partial interval: uniform on [0, heartbeat), 7.5 s on average, a
quarter of a 30-second read. Both trackers now send a final `ping` on
`visibilitychange → hidden`, with `pagehide` as a backstop, and
`packages/tracker/src/exit.ts` owns the rule.

Two bounds keep it honest rather than merely generous. Below `EXIT_MIN_GAP_MS`
(1 s) there is nothing worth a beacon. Past `EXIT_MAX_HEARTBEATS` (2) intervals
of silence the heartbeat had already stopped — blurred, hidden or idle — so the
gap is absence, not attention, and a tab backgrounded for five minutes earns
nothing. Sending the exit ping updates the last-hit time, which is what stops
the `pagehide` arriving milliseconds after a hide from sending a second one.
Hiding rather than unloading is deliberate: it is where attention actually
stops, and on mobile Safari it is the last callback that reliably runs at all.

### Compatibility contract

The golden corpus in `apps/server/test/fixtures/matomo/` (real access-log
query strings + edge cases) defines "compatible". CI replays it and asserts
the normalized `Hit` rows. If a captured production request ever normalizes
differently, that's a failing test, not an opinion.

## 2. Native tracking (new sites, R14)

- `POST /api/collect` — JSON, single or batch:

```jsonc
{
  "site": 4,
  "hits": [
    { "type": "pageview", "url": "https://deep-timeline.org/era/cambrian", "title": "Cambrian" },
    { "type": "event", "category": "share", "action": "copy-link" }
  ]
}
```

  The wire format is flatter than the normalized `Hit`: event fields ride at
  the top level and `ingest/native.ts` lifts them into `Hit.event`. The
  vocabulary is `CollectHitSchema` in `packages/shared` — the wire cannot
  declare `visitorId`, `uid` or `clientIpOverride`, because identity and geo
  are the server's to decide (invariant 3).

- **Degradation is per hit, never per request** (invariant 4). A malformed
  entry is dropped and the rest of its batch recorded; an optional field the
  schema rejects costs itself and not the hit carrying it; a batch longer than
  `MAX_COLLECT_HITS` (50) is truncated rather than refused. The endpoint
  answers **204 whether or not it understood anything**, and it is public
  despite living under the otherwise-gated `/api/` prefix — the auth route
  matrix in `auth/app.test.ts` holds it that way.

- `packages/tracker` ships `tracker.js` (< 2 KB gz, ESM):
  `init({site, endpoint})`, auto pageviews with a `history` hook (opt-out),
  auto outlink/download, focus-gated engagement pings, `track(name, props?)`.
  CORS: `Access-Control-Allow-Origin: *` on collect only — belt and braces,
  since `send.ts` keeps every beacon CORS-safelisted (`text/plain` body,
  `no-cors` fetch fallback) and so never triggers a preflight at all.
- **Idle gating (native tracker only):** focus alone overstates engagement —
  a tab left focused on a second monitor pings forever. The native tracker
  additionally stops pinging when there has been no input signal (pointer,
  key, scroll, touch) for ~60 s, resuming on the next one. The matomo.js shim
  deliberately does NOT do this: it must match Matomo's focus-only semantics
  during the bake, or the reconciliation numbers drift for tracker reasons
  rather than definitional ones.

## 3. Query API — the performance contract

### `POST /api/query`

One request per dashboard render. The body scopes a site + range and lists
every widget's query; the response answers all of them from one read
transaction.

```jsonc
{
  "site": 4,                        // or "all"
  "range": { "preset": "30d" },     // or { "from": "2026-06-01", "to": "2026-06-30" }
  "compare": "previous",            // optional: previous period | same period last year
  "filters": [                      // optional, applied to every query
    { "dim": "country", "op": "eq", "value": "US" }
  ],
  "queries": [
    { "id": "kpis",    "metrics": ["visitors", "pageviews", "engaged_ms", "bounce_rate"] },
    { "id": "series",  "metrics": ["visitors", "pageviews"], "bucket": "day" },
    { "id": "pages",   "metrics": ["pageviews", "visitors"], "dim": "path", "limit": 10 },
    { "id": "refs",    "metrics": ["visitors"], "dim": "ref_domain", "limit": 10 },
    { "id": "geo",     "metrics": ["visitors"], "dim": "country" },
    { "id": "heatmap", "metrics": ["pageviews"], "dim": "local_hour", "dim2": "weekday" }
  ]
}
```

Response:
`{ results: { [id]: { rows, compare?, bucket?, axis?, measures? } | { error } }, meta: { generatedInMs, dataVersion, windows } }`.
A query the vocabulary cannot answer honestly (e.g. `bounce_rate` × `title`) or
a kind that ships in a later milestone yields a per-query `error` entry — the
batch itself still succeeds, and never returns wrong numbers.

- **Ranges: five calendar presets, one rolling one, or explicit dates.**
  `today` · `24h` · `7d` · `30d` · `90d` · `mtd`, or `{from, to}`. Every one of
  them resolves per site timezone (`site: "all"` resolves one window per site),
  and all but `24h` resolve to whole inclusive `local_date` bounds — the tz math
  happened at ingest, so a calendar window is a plain indexed string comparison.

  **`24h` is the rolling one**: the last 24 hour buckets, ending with the one in
  progress. It exists because a calendar day is a bad comparison — *"'today'
  always reports lower than yesterday especially in the morning, whereas 24 hour
  periods are directly comparable to the previous 24 hrs."* Three consequences:

  - **It is quantized to the site's local hour**, never to the request instant.
    An edge that followed the clock would resolve a different window on every
    request, so the ETag would change on every request and revalidate nothing.
    Within an hour the window is fixed; when the hour turns it rolls, and the
    ETag expires with it — the same contract `today` has at local midnight, one
    granularity down. The quantum is the *local* hour: in a 45-minute zone
    (Kathmandu) a UTC-hour floor would leave the oldest bucket three quarters
    outside the window.
  - **Its window carries instants.** It begins and ends inside a local date, so
    `meta.windows` adds a half-open `fromTs`/`toTs` in UTC ms beside the dates
    (the dates are the two the span touches). The compiler keeps both: the
    indexed `local_date` bound does the seek, and the instants trim the two
    partial dates at the ends. `events` are dated by `ts` and `sessions` by
    `started_at` — a visit belongs to the window it *started* in, exactly as it
    belongs to the local date it started on.
  - **Its axis is 24 hour keys crossing local midnight**, enumerated from the
    window's own instants rather than by expanding its two dates (which would
    give 48). It is 24 keys across a spring-forward — no real time is lost, only
    a label — and **23 across a fall-back**, where one key covers the two real
    hours that share it. Same rule as a local day's axis, which is 23 or 24 keys
    for the same reason.
- **Compare is never clipped to elapsed time.** `previous` is the same-length
  window immediately before; `year` is the same window one year back. A partial
  current period is therefore compared against a *complete* previous one:
  `today` at 09:00 reads 9 hours against a full yesterday, and `mtd` reads a
  part-month against the equivalent number of complete days before it. That is
  how every calendar-range analytics product reads, and clipping would make
  "yesterday" silently mean "yesterday until 09:00" — a label that lies in the
  other direction. **`24h` is the like-for-like answer**: both sides are 24 hour
  buckets, so its comparison needs no clipping to be honest. Adding the preset
  beats mutating what `today` means.
- **The response describes itself.** Resolving a range preset needs the site's
  timezone and a clock; enumerating a chart's x axis needs that *and* the
  granularity the query ran at. The server has all three, so it says what it
  computed and no client re-derives it. An earlier draft of this section called
  the field `meta.range`; it is **`meta.windows`**, plural, and the plural is
  load-bearing:

  ```jsonc
  "meta": {
    "generatedInMs": 16.4,
    "dataVersion": 91824,
    "windows": [                                  // one per site in scope
      { "siteId": 4, "timezone": "America/New_York", "from": "2026-06-30", "to": "2026-07-29" }
      // a rolling window adds "fromTs"/"toTs" (UTC ms, half-open) beside its dates
    ]
  }
  ```

  `site: "all"` fans out across sites whose timezones differ, so around a local
  midnight there is no single window that describes the batch. This is the same
  array the ETag hashes.
- **Bucketed results carry their axis.** A result grouped by `bucket` states the
  granularity it ran at and the bucket keys it enumerated, per site:

  ```jsonc
  "series": {
    "rows": [ { "bucket": "2026-07-29", "visitors": 41 } ],   // SPARSE
    "bucket": "day",
    "axis": [ { "siteId": 4, "keys": ["2026-06-30", "…", "2026-07-29"], "clip": "2026-07-29" } ]
  }
  ```

  **Rows stay sparse** — the axis is the key list a client zips them against,
  never a promise of a row per key. Dense zero-filling is deliberately *not* the
  contract: `pages~<id>` (`path × day`) is unlimited by design, so filling it
  would manufacture tens of thousands of rows on a code path a stored layout
  reaches through a public share link. For that reason `axis` is emitted only
  when `bucket` is the result's one grouping besides `site` (the dimension the
  axis is already keyed by), and only while the window enumerates at most
  `MAX_AXIS_KEYS` keys.

  `keys` is a pure function of the window and the granularity — never of the
  clock — so a body replayed from cache on a 304 can never state a stale axis.
  (A rolling window's *resolution* reads the clock, but the window it resolves
  to is fixed for the hour and travels in `meta.windows`; the axis is still a
  function of that window alone.)
  `clip` is the clock-dependent part: the newest key whose bucket had **begun**
  when the response was generated, which is where real data stops inside the
  window. `today` resolves to a whole local day, so its hour axis runs to
  `23:00` while only the keys through `clip` can hold anything; padding past it
  invents future zeros. A reader whose clock has moved on since the fetch shows
  *more* than `clip`, never less — that one trim is the only time derivation
  left in the browser.
- **Hour keys come from the zone, not from counting.** A spring-forward day has
  23 hour keys and no `02:00` (an hour that never happened, so SQL can never
  return a row for it); a fall-back day has 24, with the doubled local hour
  sharing one key because both passes carry the same `local_hour`.
- **Every result declares its measures.** A number alone does not say what it
  counts or how two of them combine, and a client that guesses gets it wrong in
  a different way on every screen. So each result carries a `measures` header —
  **once per result, never per value**, because a 1000-row breakdown must not
  ship 1000 copies of its own schema:

  ```jsonc
  "kpis": {
    "rows": [ { "visitors": 41, "engaged_ms": 900000, "engaged_sessions": 9, "avg_engagement": 100000, "bounce_rate": 0.31 } ],
    "measures": {
      "visitors":         { "unit": "count", "population": "actions",           "aggregate": "distinct" },
      "engaged_ms":       { "unit": "ms",    "population": "sessions",          "aggregate": "sum" },
      "engaged_sessions": { "unit": "count", "population": "measured_sessions", "aggregate": "sum" },
      "avg_engagement":   { "unit": "ms",    "population": "measured_sessions", "aggregate": "ratio",
                            "of": { "numerator": "engaged_ms", "denominator": "engaged_sessions" } },
      "bounce_rate":      { "unit": "rate",  "population": "sessions",          "aggregate": "ratio",
                            "of": { "denominator": "visits" } }
    }
  }
  ```

  - **`population`** is the named row set the figure is drawn from (03 §
    Populations). It is stated per result because it can depend on routing:
    `visits` is a count of `sessions` rows normally and a distinct count over
    `actions` under an event-level dimension.
  - **`unit`** decides how the number is written and how a delta reads: `count`,
    `ms`, `value`, and `rate` — which is **always a fraction in 0–1**. The
    server never pre-scales a percentage, so a tile and its own sparkline cannot
    end up on different scales, which they once did (one on 0–1, one on 0–100).
  - **`aggregate` is the load-bearing field**, because a chart re-aggregates
    whatever it is sent: a 90-day series reduced to 12 sparkline slices has to
    combine buckets, and you cannot average an average. `sum` adds. `ratio`
    re-weights on its declared `of.denominator` — `Σ(vᵢ·dᵢ)/Σdᵢ`, which
    reconstructs the true numerator — or divides `of.numerator` by it directly
    when the result carries both. `max` takes the extremum. **`distinct` has no
    total across buckets at all** and refuses to produce one: a visitor active
    on two days is one visitor and two visitor-days, and the id salt rotates at
    00:00 UTC besides (03 § Visitor identity). `measureTotal` in
    `packages/shared` returns `undefined` for it, so under TS strict a caller
    must say what it does instead of quietly shipping a number that contradicts
    the same label one screen over.
  - Sequence results (`transitions`, `flows`) carry no header: their columns are
    a step signature and the sessions that walked it, not measures. `dwell` does
    — and its `measured_pageviews` population is why "time on page 31 s" and
    "avg engagement 2 s" are both true of the same traffic: per timed page leg
    versus per measured visit.

- **Vocabulary, not SQL.** Metrics: `visitors`, `visits`, `pageviews`,
  `events`, `outlinks`, `downloads`, `engaged_ms`, `engaged_sessions`,
  `avg_engagement` (engaged time per MEASURED visit — see 03), `bounce_rate`
  (engagement-aware — see 03),
  `views_per_visit`, `event_value_sum`. Dimensions: `path`, `hostname`, `title`,
  `target_url` (the outlink/download destination), `ref_domain`,
  `ref_type`, `utm_*`, `country`, `region`, `city`, `browser`, `os`,
  `device_type`, `screen`, `lang`, `event_category`, `event_action`,
  `event_name`, `local_hour`, `weekday`, plus `bucket`: `hour|day|week|month`.
  Filter ops: `eq`, `neq`, `in`, `contains`, `starts`, and `is_null` (no
  value — matches the NULL group a breakdown returns, e.g. direct traffic
  under `ref_domain`). The compiler maps this vocabulary to parameterized SQL;
  anything outside it is a 400.
- **Sequence queries** don't fit metric × dimension, so they are their own
  kinds, still inside the same batch envelope:
  `{ "id": "sankey", "kind": "transitions", "steps": 3 }` — weighted
  step→step edges from the entry page (pages and events), for the journey
  sankey; `{ "id": "journeys", "kind": "flows", "steps": 4, "limit": 20 }` —
  top session signatures with session count, avg engaged time, and exit
  rate. Both respect the surrounding site/range/filters (so "journeys of
  visitors from HN" is just a filter). Because they scope *sessions*, a filter
  only the events table can answer (`path`, `event_category`, …) cannot honestly
  narrow them and yields the same per-query `unsupported`. Both kinds collapse
  consecutive identical labels into one step, so a `transitions` edge never runs
  from a node to itself and no `flows` signature repeats a label back to back
  (see 03 § Journeys).
- **Time on page** is its own kind for the same reason — it counts page legs,
  not rows: `{ "id": "dwell", "kind": "dwell", "limit": 10 }` → rows of
  `{ path, views_measured, avg_page_ms, max_page_ms }` ranked by average dwell,
  over the same session-scoped envelope (and the same honest refusal of
  event-level filters). Semantics live in 03: every event, **pings included**,
  credits `min(gap to the next event, 20 s)` to the most recent pageview. Views
  that nothing followed are **excluded, never zeroed** — `views_measured` is the
  count the average rests on, so a card can say "37 measured" instead of
  implying it timed every view.
- **Click-to-filter falls out for free**: clicking a row in any breakdown adds
  a `filters` entry and re-issues the same batch.
- **Caching**: response ETag = hash(max event rowid, schema version,
  canonicalized request body, resolved per-site windows *including their
  timezones and any rolling instants* — so a preset like `today` expires at
  site-local midnight even when no data changed, `24h` expires when the site's
  local hour turns and is stable in between, and re-zoning a site expires an
  explicit `from`/`to` range whose bounds did not move but whose hour axis did).
  Unchanged data → 304 with zero queries executed. Realtime SSE tells the
  client *when* to revalidate, so there's no polling loop.
- **Rate limit.** A stored dashboard is a client-authored query plan executed
  server-side, and better-sqlite3 is synchronous — while a batch runs it owns
  the event loop that also answers beacons. The response-size budget above
  bounds one answer; this bounds how many of them anyone can ask for: **120
  executed batches per minute per session, 600 per minute for the instance**.
  Over budget answers `429` with `Retry-After: 60` and
  `{"error": "too many query batches — try again in a minute"}`; the SPA holds
  its last good response, says "Live update failed — showing the last good
  result", and offers retry — it never blanks.
  - **Keyed on the session, not the address.** This route is behind the session
    gate, so every request that reaches it names a principal the server minted
    itself. One session keeps one budget however many addresses it arrives
    from (a roaming phone, a stolen cookie replayed from a botnet), and an
    office behind one NAT does not throttle itself. `/share/:token` and
    `/api/admin/login` are keyed on the IP with tighter budgets because they
    are unauthenticated and nothing better exists there — an anonymous link
    holder and an accountable owner are not the same risk.
  - **Only executed batches are charged**, never a 304 and never a refusal.
    Charging refusals would let ordinary polling — a live view re-queries every
    3 s — hold a tripped budget shut indefinitely, which is a worse outage than
    the burst it was defending against.
  - Sized from the client's own cadence rather than a guess: one view
    revalidates at most every 3 s, so the per-session budget is six live views
    saturated for a full minute. `test/contract/rate-limit.test.ts` drives the
    shipped dashboards at the shipped cadence and fails if either number moves
    out from under the other.
- `"site": "all"` grants the all-sites overview the same one-request property,
  with per-site grouping in the rows.

## 4. Realtime

### `GET /api/realtime?sites=all` (SSE)

`sites` is `all` (the default) or a comma-separated list of site ids; every
event below is scoped to it. Anything else is a 400 — a malformed filter
fails closed, never widening to every site.

- On connect: `snapshot` event — active visitors (distinct visitors, last
  5 min) per site + the last 50 enriched events (site, type, path, country,
  city, lat/lon, device — never IP or visitor id). Active counts survive a
  restart: they are seeded from the sessions last seen inside the window.
- `snapshot` and `active` also carry `visitors`: one
  `{name, color, siteId, engagedMs, lastTs}` per visitor seen in the last
  30 minutes — the realtime card's tally window. `engagedMs` is accrued
  exactly as the sessionizer accrues `engaged_ms` (docs/03: every event,
  **pings included**, credits its gap clamped at 20 s), and covers the
  visitor's CURRENT session: a gap past the 30-minute session timeout starts
  it over, so the figure reads as time on site rather than a daily total. The
  rows are keyed by the same per-day alias the hits wear — the join the
  dashboard makes — and are seeded on boot from the same session rows the
  active counts come from, so a deploy does not zero everyone's time.
- Every hit (snapshot and live) carries `visitor: {name, color}` — an
  **ephemeral per-day alias** (`Avaricious Aardvark` plus a categorical
  palette index), derived one-way from `sha256(UTC day ∥ visitor_id)` against
  the curated word lists in `packages/shared` (see docs/03 § Visitor
  identity). It exists so several hits from one city read as one visitor or
  several; it resets at 00:00 UTC, collides harmlessly at this fleet's scale,
  and is the ONLY identity-shaped field on the wire — the visitor id itself
  never appears, and there is still no visitor dimension in the query
  vocabulary.
- Then: one `hit` event per ingested non-ping hit, same shape, emitted
  post-enrichment rather than post-flush — the feed never waits for a batch.
  A ping keeps its visitor active but is not a feed item. `active` recounts on
  a 10 s tick; `version` carries `{siteId, version}` for each site whose data
  landed in a flush — the tick every dashboard view revalidates on (see 02).
- Only `hit` events carry an SSE `id`, so `Last-Event-ID` always names a ring
  entry: a resuming client gets a `snapshot` with an empty `recent` plus its
  missed hits replayed as `hit` events. A heartbeat comment every 25 s keeps
  proxies from reaping the stream. A connection that stops draining is
  dropped once ~1000 frames are queued for it; reconnecting with
  `Last-Event-ID` recovers what the ring still holds.

This feeds the live counter, the realtime feed, and the map/globe from a
single stream.

## 5. Admin & operations

Conventional REST under `/api/admin` (session auth + CSRF): sites CRUD,
dashboards CRUD (layout JSON — writes validate the schema AND the batch
invariants: unique query ids, derived-query count within the batch cap),
share/API tokens, ntfy notification settings (`GET`/`PUT`/`DELETE
/api/admin/ntfy`, R16 — `DELETE` is the off switch; the endpoint URL must be
https or loopback-http, carry no query/fragment, and never point at link-local
or cloud-metadata hosts), auth (`login`, `logout`, first-run setup). Read-only
dashboard access via `GET /share/:token`: the server re-validates the stored
layout and assembles the SAME batch the in-app view would run (widget queries
plus derived companions, previous-period compare), so the link cannot be
turned into the query API — the one client knob is `?range=<preset>`. Because
this is the one unauthenticated route that executes queries on the
synchronous SQLite path, executed batches are rate-limited (per-IP plus a
global budget; 304 revalidations are free) and every `/share` response
carries `X-Robots-Tag: noindex`. Operations: `/healthz` (liveness + last-flush age) and
Prometheus `/metrics` (ingest rate, batch flush time, query p95, SSE clients,
bot drops, DB size) for the existing Grafana stack (R15).

First-run setup (`POST /api/admin/setup`) additionally requires the one-time
**setup token** the server prints to its log at first boot: between `docker
run` and the owner opening the page, an unconfigured install is reachable by
anyone, and the token makes claiming it require console access. Setup and
login share the same rate limits (per-IP plus a global budget). The client
address comes from the `TRUSTED_PROXY_HOPS`-th `X-Forwarded-For` entry from
the end (default 1 — one trusted proxy); with `0`, forwarded headers are
ignored entirely.
