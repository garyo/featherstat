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
| `url` | page URL | split → `hostname`, `path` (query string kept minus the closed tracking-param list, fragment dropped — docs/03 § Page identity) |
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

**A speculated page is not a visit (both trackers).** Speculation rules let a
browser prerender a likely-next page: it fetches, parses and *runs* the
document — tag included — before the visitor has clicked, and throws the whole
thing away if they never do. Taken at face value that is a page view, and a
visit, for a page nobody opened. The repeat guard above cannot reach it, because
a prerendered document is its own realm holding its own tracker, so two of them
are two first views rather than one announced twice. So the first page view
waits for the arrival instead: `document.prerendering` says the document is only
being speculated on, and `prerenderingchange` fires once, when the visitor
actually comes. The native tracker defers its opening `page()`; the shim defers
*taking over* `_paq.push`, which leaves the tag's commands accumulating in the
plain array they were always pushed into and drains them, in order, on arrival —
so the view carries the moment of arrival, not of speculation. A browser that
does not prerender defines neither name and pays one property read.
`packages/tracker/src/prerender.ts` owns the rule and both trackers assert it,
including the case that matters most: a prerender torn down before activation
sends nothing at all.

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

**Scroll depth (native only).** Time on page says a visitor stayed; it cannot
say they read. `packages/tracker/src/scroll.ts` keeps a per-page-view
high-water mark — `(scrollY + viewportH) / documentHeight`, whole percent,
re-measured on every reading rather than cached at load, which is the
lazy-loading trap that otherwise reports a reader as having finished an article
they are a third of the way through. The viewport is in the numerator on
purpose: without it the figure can never reach 100 and reads 0 on a page with
no scrollbar, so a page that fits is 100 — they did see all of it.

It rides the pings that already fly rather than becoming a hit type of its own,
and is **absent rather than 0** when the page could not be measured, because
0 would read as a visitor who saw nothing. `page()` resets it, so an SPA route
change starts a fresh measurement.

Passing 90 % emits **one ordinary custom event** (`scroll` / `read`), once per
page view. Ordinary on purpose: a new hit type costs eleven touch points across
the vocabulary, the populations, the corpus and the replay generator, while a
custom event already counts, filters by `event_category`/`event_action`, and
shows in the live feed — for a milestone that is exactly an event.

### Compatibility contract

The golden corpus in `apps/server/test/fixtures/matomo/` (real access-log
query strings + edge cases) defines "compatible". CI replays it and asserts
the normalized `Hit` rows. If a captured production request ever normalizes
differently, that's a failing test, not an opinion.

The shim path **never produces custom props, permanently** (docs/03 § Props):
Matomo's wire has no such field, and the shim's job is to be Matomo's wire.
Props are a native-collector feature only (§ 2).

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

- **Custom props**: any non-ping hit may carry
  `props: {key: string | number | boolean}` — e.g.
  `{ "type": "event", "category": "share", "action": "copy-link",
  "props": { "plan": "pro", "beta": true } }`. The tracker sends the bag
  untouched (zero validation bytes client-side); the server enforces every
  cap and clamps rather than bounces (docs/03 § Props). A malformed bag costs
  the bag, never the hit. Props on a ping are stripped and counted.

- `packages/tracker` ships `tracker.js` (< 2 KB gz, ESM):
  `init({site, endpoint})`, auto pageviews with a `history` hook (opt-out),
  auto outlink/download, focus-gated engagement pings,
  `track(action, {category, name, value, props})`,
  `page(url?, title?, props?)` — auto pageviews send no props —
  and scroll depth (below).
- **Every hit is addressed to the page as REPORTED**, not to `location.href`:
  once a view is announced under its own URL (an SPA naming its route, or a
  404 page reporting itself as one canonical `/404`), its pings, read
  milestone, outlinks, downloads and custom events all carry that same URL.
  Reading the address bar instead scattered one page view across two paths and
  left a second, view-less row in path reports for a page nobody visited.
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
  "compare": "previous",            // optional: "previous" | "year" | {"segment": id} | {"from","to"}
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

`limit` ranks groups by the first metric. A bucketed breakdown (`bucket` plus
`dim`/`dim2`) orders by time first, so a limit there would keep the earliest
buckets rather than the top groups; the schema refuses that combination with a
400 instead of returning the truncated rows.

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
- **Compare is a union of four forms.** The two strings above, plus:
  - **`{"segment": id}`** — the same window seen through a saved segment: the
    compiled query runs a second time with the segment's filter tree AND-ed in
    beside the request filters, and the rows land in the ordinary `compare`
    slot. "All traffic vs. US traffic" is one request. A comparison the
    segment's dimensions make unanswerable (they conflict with the metrics)
    refuses the query whole — never rows whose comparison silently vanished.
  - **`{"from", "to"}`** — an explicit compare window, validated like a range
    and **used as given** (inclusive local dates, per site timezone). When its
    day count differs from the current window the result is still emitted,
    **index-aligned from the start** — refusing would forbid legitimate
    questions — and the mismatch is labeled: each `meta.windows` entry gains
    `compareFrom`/`compareTo` exactly when the compare was this form. The
    label rule is the contract; a client that renders an unequal comparison
    unlabeled is wrong, not the server.
- **Saved segments** (`GET /api/segments`, admin CRUD under
  `/api/admin/segments`) are named filter trees. A request's `filters` — at the
  batch level or inside one query — may use the leaf **`{"segment": id}`**
  anywhere a node can appear; the server substitutes the stored tree **before
  compilation**, so the executed request (and the ETag, below) carries the
  expanded grammar and the compiler never sees a ref. Stored segment
  definitions use the same grammar WITHOUT the ref — a segment cannot
  reference a segment, so cycles are impossible by construction. An unknown or
  unreadable segment id is a 400 naming it: segments are named by the same
  operator's UI, so a bad id is a mistake to surface, not to skip.
- **Derived metrics** (`GET /api/derived-metrics`, admin CRUD under
  `/api/admin/derived-metrics`) are stored arithmetic over the metric
  vocabulary — `expr := term (('+'|'-') term)*` over metric names, numeric
  literals, `* /` and parentheses, ≤ 16 AST nodes, parsed by a tiny
  recursive-descent parser in `packages/shared` (never `eval`, never SQL). A
  query names one as **`d:<name>`** in its `metrics`. Execution is
  **post-aggregation**: the component metrics join the compiled set (their
  columns ride in the rows) and the expression is evaluated per row — compare
  rows included — in JS. Unknown operands and division by zero/null read as
  `null`, never `Infinity`. Refusals are per query and honest: an unknown
  name, a stored expression that no longer parses, or a component set past
  `MAX_METRICS_PER_QUERY`. The declared measure follows composition rules:
  exactly `A / B` over two sum-aggregates is a proper `ratio` with
  `of: {numerator, denominator}` (both columns present in the rows); any other
  shape is the aggregate **`computed`** — evaluated per row with **no lawful
  recombination**, so `measureTotal`/`measurePerBucket` return `undefined` and
  no client invents a total. Any **distinct** operand (`visitors`, routed
  `visits`) additionally refuses buckets other than `day` — a coarser bucket
  would ask the expression to recombine distinct counts, which have none.
- **Goal metrics** (`GET /api/goals?site=`, admin CRUD under
  `/api/admin/goals?site=`) are saved queries over the ordinary filter grammar
  (no segment refs — a goal cannot depend on a segment edit it does not see).
  A query names them as **`goal:<id>:conversions`**, **`goal:<id>:cr`** or
  **`goal:<id>:value`** in its `metrics`, beside built-ins and `d:` refs.
  Semantics:
  - A **conversion** is a session with ≥ 1 non-ping event matching the goal's
    filters — `COUNT(DISTINCT session_id)`, compiled as one extra events-table
    statement per goal through the same filter compiler as every client filter
    and merged with the query's own statements on the group keys. Request
    filters apply inside it, so "conversions from mobile" is just a filter.
  - A conversion's **bucket is the completing event's local date** — a
    deliberate simplification from "the session's start date": the day the
    completing event happened is the honest reading of *when did this
    convert*, and it needs no join. A session converting on two days counts
    on both (`aggregate: "distinct"` — no client-side total, like
    `visitors`).
  - **`cr`** = conversions / `visits`, declared as a proper `ratio`
    (`of: {numerator, denominator: "visits"}`); the denominator joins the
    compiled set and rides in the rows like a derived metric's components.
  - **`value`** follows the goal's `valueExpr`: `SUM(event_value)` over the
    matching events (`aggregate: "sum"`), fixed × conversions
    (`aggregate: "computed"` — no lawful total), or `null` when the goal
    defines none.
  - **Hour shapes refuse** (`bucket: "hour"` or the `local_hour` dimension):
    sessions span hours as a matter of course, so per-hour distinct sessions
    would manufacture recombinable-looking numbers. Session-only groupings
    (`entry_path`/`exit_path`) refuse too — goal statements aggregate the
    events table. All refusals, plus an unknown goal id, a goal of a site
    outside the request's scope, and an unreadable stored row, are honest
    per-query `{error}` entries, never a 500.
  - Goal metrics always route to **raw rows** (the planner treats any
    non-built-in metric as raw), and definitions resolve on the main thread
    and hash into the ETag — editing a goal expires every cached answer that
    used it, exactly as segments and derived metrics do.
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
    site-local midnight besides (03 § Visitor identity). `measureTotal` in
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
  `event_name`, `local_hour`, `weekday`, plus the session-only `entry_path`
  and `exit_path` — only the sessions table carries those, so grouping or
  hit-scope filtering by one refuses event-level metrics (`pageviews`,
  `visitors`, …) exactly as an event-only dimension refuses session metrics;
  a `scope: "session"` filter on one names a session attribute and blocks
  nothing. **`campaign_status`** (`registered | unregistered | untagged`) is
  derived at query time from the campaigns registry (docs/03 § Campaigns):
  `untagged` when the row has no `utm_campaign`, `registered` when a registry
  row of the row's site names it and its lifespan (NULL = open) covers the
  row's local date, `unregistered` otherwise. Both tables carry the CASE, so
  it groups and filters like any stored dimension; editing the registry
  reflects instantly (no backfill), and it is raw-only — never rolled up.
  Plus `bucket`: `hour|day|week|month`.
  **`prop:<key>`** (key charset `[a-z0-9_-]{1,32}`) is the one open-ended
  dimension family: it groups/filters over the event's custom-prop bag
  (docs/03 § Props), compiled to `json_extract(events.props, ?)` with the
  path bound server-side — the key never enters SQL text. Event-only (session
  metrics under it refuse), always answered from raw rows, works with every
  filter op (`is_null` = the key is absent) and with `scope: "session"`.
  Filter ops: `eq`, `neq`, `in`, `contains`, `starts`, `glob` (SQLite GLOB,
  pattern bound as a parameter, length- and wildcard-capped), and `is_null`
  (no value — matches the NULL group a breakdown returns, e.g. direct traffic
  under `ref_domain`). The compiler maps this vocabulary to parameterized SQL;
  anything outside it is a 400.
- **Which store answers is invisible.** Per query, the planner
  (`query/planner.ts`, rules in 03 § Rollups) routes eligible metric shapes to
  the rollup tables and everything else to raw rows. The wire never says
  which: rows, ordering and the `measures` header are identical by
  construction (a read-equivalence ratchet holds both stores row-for-row
  equal). One visible edge exists — the retention raw floor: once
  `retention_days` has pruned old raw rows, a query only raw rows can answer
  (a raw-only dimension like `title`, `dim2`, joint filters, a cross-day
  distinct, session-scoped filters, the sequence kinds) refuses a window
  reaching below the floor with the per-query
  `{ "error": { "code": "unsupported", "message": "raw events for part of
  this range have been pruned…" } }` — never partial numbers. Rollup-served
  shapes keep answering over the whole retained history.
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
- **Adjacency** is the one-page slice of the same machinery:
  `{ "id": "in", "kind": "adjacency", "path": "/pricing", "direction": "in" }`
  → rows of `{ label, sessions }` counting the DISTINCT sessions in which the
  named page was reached from `label` (`"out"`: left toward it), anywhere in
  the session, top `limit` (default 10). Sessions that start at the page read
  as the pseudo-row `(entry)` under `in`; sessions that end there as `(exit)`
  under `out`. Same envelope, same collapse: a reload or double-announce is
  never an adjacency, and the page is never its own neighbor.
- **Time on page** is its own kind for the same reason — it counts page legs,
  not rows: `{ "id": "dwell", "kind": "dwell", "limit": 10 }` → rows of
  `{ path, views_measured, avg_page_ms, max_page_ms, views_scrolled,
  avg_scroll_pct }` ranked by average dwell,
  over the same session-scoped envelope (and the same honest refusal of
  event-level filters). Semantics live in 03: every event, **pings included**,
  credits `min(gap to the next event, 20 s)` to the most recent pageview. Views
  that nothing followed are **excluded, never zeroed** — `views_measured` is the
  count the average rests on, so a card can say "37 measured" instead of
  implying it timed every view.
- **Scroll depth rides the same rows** (native tracker only): the tracker keeps
  a per-page-view high-water mark and puts it on the pings it already sends, so
  `avg_scroll_pct` is the average of those maxima per page — a `rate`, scaled to
  a percentage once by the client. Its own count, `views_scrolled`, because a
  page view can be timed and still carry no reading (the shim, the importer,
  anything before schema v5), and a page with none is left OUT of the average
  rather than averaged in at 0 %.
  **The aggregation deliberately does not share dwell's row filter.** Dwell
  skips each session's last hit, whose gap is unmeasurable — but that hit is
  usually the exit ping, which carries the page's deepest reading. Reading
  scroll under that filter returns the second-deepest reading of every page,
  every time: silent, systematic, and always low. Depth is a high-water mark,
  not a gap, so it is aggregated over all of a leg's rows.
- Both `dwell` and `distribution` take an optional `path`: a **leg selection**,
  not a session filter — sessions still qualify by the envelope, and only their
  legs on that page are counted.
- **Distributions** histogram the same legs with fixed buckets:
  `{ "id": "d", "kind": "distribution", "of": "dwell" }` → rows of
  `{ bucket, legs }` over the duration bands `0–10s | 10–30s | 30–60s | 1–3m |
  3m+`; `"of": "scroll"` buckets each measured leg's deepest reading into
  deciles `0–9` (100 % belongs to 9). Rows are sparse — empty buckets are
  omitted — and scroll counts only measured legs: an unmeasured leg is in no
  bucket, never in bucket 0.
- **Filters ride at two levels, and both reach the same envelope.** The
  request's `filters` apply to every query; a query's OWN `filters` — the
  per-widget filters of docs/05 — are AND-ed with them for that query alone.
  This holds for **every** shape, metric and kind alike: a `distribution`,
  `dwell`, `adjacency`, `transitions`/`flows` or `changes` query carrying its
  own filters narrows its session envelope exactly as a request filter would
  (and refuses a hit-scoped event-level leaf exactly as one would). Dropping
  them would be the worst failure this API can have — the wider answer under
  the narrower label — so each kind has a test that its filtered rows differ
  from its unfiltered ones.
- **What changed** is the contribution-ranking kind:
  `{ "id": "ch", "kind": "changes", "metric": "visits", "dims": ["path",
  "ref_domain", "utm_campaign", "country"], "limit": 8 }` (every field past
  `kind` defaults to exactly those values). It **requires a time `compare`** on
  the request — that pair of windows is the question — and refuses a
  `{segment}` compare, which has no second window. Per dimension the server
  runs the ordinary grouped metric query over BOTH windows **unlimited**,
  outer-joins the two row sets on the dimension value, and keeps the top
  `limit` movers by |delta| (ties: higher current first). Rows are
  `{ dim, value, current, previous, delta, share }`, all dims concatenated in
  request order with `dim` separating the sections.
  - **Server-side because of the union of keys**: a page that fell out of the
    current period's top N is exactly the mover that explains a drop, and a
    client composing two top-N answers structurally cannot see it. Absent
    keys read as 0 on the side they are absent from.
  - **`share`** = the row's delta over the dimension's WHOLE net change
    (Σcurrent − Σprevious before the limit), so the kept rows state how much
    of the move they explain. Shares over the full row set sum to 1; a single
    row's can exceed ±1 when movers cancel. `null` when the totals net to
    zero — shares of nothing are not numbers.
  - **`visitors` deltas wear the `~`**: each window's number is a per-window
    distinct, so the delta is a difference of two approximations. The
    `measures` header declares `current`/`previous`/`delta` with the metric's
    own measure (`visitors` → aggregate `distinct`) and `share` as `computed`;
    the metric's measure is declared from its preferred table, though a
    dimension may route a sub-query to the other store — the rows here are a
    ranking, not inputs to client-side re-aggregation.
  - Request filters apply inside every sub-query, and the sub-queries route
    through the ordinary planner — day-grain shapes ride the rollups, and a
    raw-needing shape (e.g. `visitors` over a multi-day window) below the
    retention horizon refuses the whole query honestly.
- **Click-to-filter falls out for free**: clicking a row in any breakdown adds
  a `filters` entry and re-issues the same batch.
- **Caching**: response ETag = hash(max event rowid, schema version,
  canonicalized request body, resolved per-site windows *including their
  timezones and any rolling instants* — so a preset like `today` expires at
  site-local midnight even when no data changed, `24h` expires when the site's
  local hour turns and is stable in between, and re-zoning a site expires an
  explicit `from`/`to` range whose bounds did not move but whose hour axis did).
  Unchanged data → 304 with zero queries executed; `If-None-Match` compares
  weakly (RFC 9110), so a proxy that forwards the tag as `W/"…"` still
  revalidates. Realtime SSE tells the client *when* to revalidate, so there's
  no polling loop. Refinements:
  - **The canonical body is the EXPANDED request** — segment refs substituted,
    derived-metric definitions hashed beside it. Editing a segment or a
    derived metric therefore expires every cached answer that used it with
    zero extra bookkeeping, even though the data version never moved; and two
    spellings of one question (`{segment: id}` vs. its tree written inline)
    share one tag.
  - **Each window's tag folds in `min(to, site-local today)`.** Presets never
    need it (their dates move with the clock), but an explicit range whose
    `to` is today or later has static bounds over a moving clip — without the
    fold, a dashboard left open overnight would 304 forever while today's
    rows drained into a day the cached body shows empty. A fully past range's
    fold equals its own `to`, so those tags stay stable and cacheable.
  - **`annotations_version` joins the hash only for annotation-opted
    requests** (below): an annotation edit expires exactly the cached answers
    that show notes, and no others.
- **Annotations ride the batch, opt-in.** `"annotations": true` on the request
  adds `meta.annotations`: `[{ id, siteId, ts, text }]`, filtered to the
  request's sites (a null-site note matches every site) and to the resolved
  windows — by instants for the rolling `24h`, otherwise by the note's
  site-local date. Opt-in keeps the one-fetch contract (the notes arrive with
  the batch that renders them) without taxing every dashboard's cache with a
  counter it never shows. Delivery happens on the main thread after execution —
  annotations are settings-grade rows, not query work — and the **share route
  never sets the flag**: share links stay minimal. Writes live under
  `/api/admin/annotations` (§ 5); every write bumps the monotonic
  `annotations_version` settings counter the ETag folds in.
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
- **CSV export.** `POST /api/query?format=csv` (or `Accept: text/csv`) answers
  the SAME executed batch as CSV — same validation, scoping, rate class and
  ETag machinery, different serialization. One query per CSV: a single-query
  batch needs no selection, a larger one names its query with `?query=<id>`,
  and an ambiguous or unknown selection is a 400 saying so
  (`csv needs exactly one query — pass ?query=<id>`). A per-query `{error}`
  entry cannot ride beside siblings here — it IS the whole response, so it
  answers 400 with the error's message.
  - **Columns**: the group keys as the compiler orders them (`bucket`, then
    `dim`, `dim2`), headed by the vocabulary words themselves, then one column
    per metric in request order; anything else the rows carry (a derived
    metric's components, a goal `cr`'s `visits` denominator) follows sorted.
    Sequence kinds use their natural columns — `flows` joins its signature
    with `" > "` into a `steps` column beside its counts; `transitions` is
    `step`, `from`, `to`, `sessions`; `dwell`/`adjacency`/`distribution`
    exactly as their JSON rows read.
  - **Dialect**: pure RFC 4180 — fields containing a comma, quote, CR or LF
    are quoted with `""` doubling (dimension values are visitor-controlled
    text, so this is load-bearing), CRLF records, UTF-8 without BOM. Null and
    a sparse row's missing cell are empty fields, never zeros; rates stay
    fractions in 0–1, exactly as `measures` declares them. No spreadsheet
    formula-escaping (`packages/shared/src/csv.ts` documents the choice).
  - **Compare** prepends a `period` column (`current`/`previous`) and appends
    the compare rows. The resolved window travels in an
    `X-Featherstat-Window: <from>/<to>` response header (the first site's).
  - **ETag**: the canonical body folds in the format and the selected query
    id, so a CSV tag and a JSON tag for one batch never cross — a 304 minted
    against one can never validate a cache holding the other.
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
- Then: one `hit` event per ingested hit — **every** hit, heartbeats included —
  emitted post-enrichment rather than post-flush, so the feed never waits for a
  batch. `active` recounts on a 10 s tick; `version` carries
  `{siteId, version}` for each site whose data landed in a flush — the tick
  every dashboard view revalidates on (see 02).
- **The feed is the raw stream, and a row carries nothing derived.** Pings were
  once dropped here as noise, and a row instead carried "how long the visit had
  been going when this landed". That figure could not be summed (4 s, 6 s and
  8 s under a tally of 54 s reads as a contradiction), and the boot path could
  not reconstruct it, so it silently substituted the visit's TOTAL — a row meant
  one thing live and another after a restart. Sending the heartbeat is cheaper
  than deriving its meaning twice.
- **Time on page is recovered by collapsing, in the client**
  (`lib/realtime.ts` `collapseRuns`): consecutive hits from one visitor on one
  page are one row, and the row's figure is the run's span. It agrees with the
  time-on-page card by construction — same `PING_CLAMP_MS` on every gap, and a
  run's last hit credits its gap to the page being left, exactly as
  `query/dwell.ts` attributes it. The newest run is unmeasured rather than 0 s
  until a hit closes its gap. Heartbeats leave no other mark; anything the
  visitor DID is counted and shown as `+N`, because "read for 90 s" and "read
  for 90 s and hit subscribe" must not render identically — and an unfamiliar
  hit type counts as an action rather than being absorbed.
- Only `hit` events carry an SSE `id`, so `Last-Event-ID` always names a ring
  entry: a resuming client gets a `snapshot` with an empty `recent` plus its
  missed hits replayed as `hit` events. A heartbeat comment every 25 s keeps
  proxies from reaping the stream. A connection that stops draining is
  dropped once ~1000 frames are queued for it; reconnecting with
  `Last-Event-ID` recovers what the ring still holds.

This feeds the live counter, the realtime feed, and the map/globe from a
single stream.

## 5. Admin & operations

**The wall is split in two** (auth/routes-policy.ts): every `/api/admin/*`
route is classified either **manager** — open to the admin and to user
principals, whose handlers then check `canManageSite` per object — or
**admin-only**, and admin-only is the default, so a route added tomorrow is
born admin-only exactly as it is born authenticated. Manager routes: sites
CRUD, dashboards (+ share links), goals, campaigns, annotations, viewer/token
mint-list-revoke, logout, password. Admin-only: user accounts, data settings,
prop scrubs, exclusions, diagnostics, ntfy, and writes to the
global-namespace objects (segments, derived metrics, campaign aliases, alert
rules) — users read those, only the admin writes them. Out-of-scope writes
answer **404 exactly like nonexistent**, everywhere; an `'all'`-scope
dashboard or install-wide annotation is admin-write and answers 403 to a
user, since `'all'` is not an object to hide.

Conventional REST under `/api/admin` (session auth + CSRF): sites CRUD,
dashboards CRUD (layout JSON — writes validate the schema AND the batch
invariants: unique query ids, derived-query count within the batch cap;
**reads also live outside the wall** at `GET /api/dashboards` and
`GET /api/dashboards/:id`, open to every gated principal and scope-filtered:
a site-scoped dashboard is visible to any principal that can read its site,
an `'all'`-sites dashboard — which aggregates every site — only to principals
whose own scope is `'all'`, and out of scope answers 404 exactly like
nonexistent; the `/api/admin/dashboards` read paths remain for the SPA until
it migrates),
segments, derived-metrics, goals and campaigns CRUD (`/api/admin/segments`,
`/api/admin/derived-metrics`, `/api/admin/goals?site=`,
`/api/admin/campaigns?site=`; the read lists ride outside the wall at
`GET /api/segments`, `GET /api/derived-metrics`, `GET /api/goals?site=` and
`GET /api/campaigns?site=`, session-gated but open to
every principal — a viewer or token composes queries with them exactly as the
admin does), campaign aliases (`GET`/`PUT /api/admin/campaign-aliases?site=`,
full-list replace per site, site 0 = install-wide; a PUT invalidates the live
ingest cache, enqueues the chunked utm backfill in the same transaction, and
kicks it — docs/03 § Campaigns), share/API tokens, ntfy notification settings (`GET`/`PUT`/`DELETE
/api/admin/ntfy`, R16 — `DELETE` is the off switch; the endpoint URL must be
https or loopback-http, carry no query/fragment, and never point at link-local
or cloud-metadata hosts), auth (`login`, `logout`, first-run setup), and props
governance (docs/03 § Props): `GET /api/admin/props?site=<id>` lists the
site's `prop_keys` stats plus its last week of `prop_drops`
(`AdminPropsResponseSchema` in `packages/shared`), and
`DELETE /api/admin/props/:site/:key` drops the key's registry rows (and the
live registry's cache) immediately, then scrubs stored bags with a chunked,
watermarked `json_remove` job (`jobs/prop-scrub.ts` — resumed at boot after a
crash) that bumps the data epoch on completion so pre-scrub ETags expire.

**Annotations** (`/api/admin/annotations`): operator notes pinned to a UTC
instant — `GET` lists (optional `?site=` keeps that site's plus the
install-wide null-site notes), `POST`/`PUT /:id`/`DELETE /:id` write
`{ siteId: id|null, ts, text ≤300 }`. Every write bumps the monotonic
`annotations_version` settings counter in the same transaction — its own
counter, NOT the data epoch, because an annotation changes no data: only the
annotation-opted query ETags hash it (§ 3). Delivery to readers is the opt-in
`meta.annotations` on the query batch; there is no separate read endpoint to
poll.

**Alert rules** (`GET`/`PUT /api/admin/alerts`): one settings row
(`alert_rules`, ≤ 20 rules, stored exactly like the ntfy hit rules — validated
on write, re-parsed on read, failing closed to no alerts). A rule is
`{ site, metric, dim?+value?, condition: above|below|delta_pct, threshold,
window: day|hour }`; `jobs/alerts.ts` evaluates hourly by running each rule as
an ordinary one-query batch (`today` for `day`, the rolling `24h` for `hour`,
`dim=value` as an `eq` filter, `compare: 'previous'` for `delta_pct`, whose
threshold is the **absolute percent change**). A breach posts through the ntfy
notifier under a per-rule cooldown key (6 h), so a condition that stays
breached repeats at most that often; a per-query refusal never alerts — a
shape the vocabulary refuses must not page anyone with a made-up number. The
**weekly digest** (`jobs/digest.ts`) rides the same notifier: one notification,
one sentence per site (7d vs previous via the `changes` kind + the visits
totals), formatted by the same `summarizeChanges` the MCP tool uses; its last
run persists in the `digest_last_run` settings row so a restart mid-week stays
quiet. Both jobs skip themselves entirely while ntfy is unconfigured.

**Traffic exclusion** (`GET`/`PUT /api/admin/exclusions`, docs/03 § Exclusions):
one settings row (`exclusion_rules`, ≤ 64 rules), a full-list replace like the
other admin settings, and a row that will not validate excludes NOTHING — the
failure that matters here is the opposite of alerts', since dropping real
traffic on a malformed rule loses data that cannot be recovered. A rule is
`{ value, note }` where `value` is an IP, a CIDR prefix, or a hostname; the
enum-free validation is structural (a prefix or a colon means an address, else
all-numeric labels do, else a hostname). The `PUT` writes the row, replaces the
live matcher's rules in the same request — a rule that only bit after a restart
would be a trap — and re-resolves hostnames before answering, so the response's
`resolutions[]` says what each name currently resolves to, when, and the error
if the lookup failed. A failed lookup is reported, never fatal: the rule keeps
matching its last known addresses. `GET /api/admin/diagnostics` carries
`excludedDrops` beside `botDrops`, same per-site/per-day shape and 7-day window,
so a rule quietly eating real traffic is visible as itself.

Read-only
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

**API tokens cross origins; cookies never do.** A Bearer token (`fs_…`, minted
under `/api/admin/tokens`) is the data-out credential, and third-party callers
— a notebook, a cron job, someone's Observable page — live on other origins.
So `/api/query` and `/api/sites` (exactly these) answer with
`Access-Control-Allow-Origin: *` when the request presented an `Authorization`
header, plus `Access-Control-Allow-Headers: authorization, content-type`,
`Access-Control-Allow-Methods: GET, POST, OPTIONS` and a day of
`Access-Control-Max-Age`. Cookie-authenticated responses carry **no** CORS
headers at all: the same-origin wall is what protects sessions, and a wildcard
on a cookie response would tear it down. The gate answers a presented Bearer
header as Bearer or 401s — never silently as the cookie — which is what makes
keying on the header safe. `OPTIONS` preflights to those two paths are
answered 204 with the CORS headers **before** the session gate, without
authentication: a preflight carries no credentials and grants nothing, it only
asks whether a real (still fully gated) request may be attempted. Every other
route stays same-origin entirely — an `OPTIONS` elsewhere meets the gate like
any request. (The CSP's `connect-src 'self'` is unrelated: it is
response-side, governing what our own pages may fetch, and says nothing to a
third-party caller.)

**Token rate class.** Token principals meter `/api/query` in their own class:
**30 executed batches per minute per token** (`TOKEN_BATCHES_PER_MIN`),
distinct from the 120/session — a token is a script, and extraction wants a
few big answers, not a revalidation loop — while sharing the same global
600/minute bucket, so the instance-wide ceiling on synchronous query work
stays one number. The same rules as the session class otherwise: 304s and
refusals are never charged, over budget answers 429 with `Retry-After: 60`.
A token's `last_used_at` is written at most hourly — an audit column, not a
log.

**Viewers: read-only humans, invited without SMTP.** A viewer is an email plus
a site scope (`'all'` or a site-id list), managed under the admin wall:
`GET /api/admin/viewers` lists them, `POST /api/admin/viewers` creates one —
or re-invites an existing email, updating the scope and clearing any
revocation — and mints a **single-use magic link** (raw token
`fsv_<43 base64url>`, sha256-at-rest like every other token, 7-day expiry);
`POST /api/admin/viewers/:id/invite` re-mints; `DELETE /api/admin/viewers/:id`
revokes the viewer and expires their outstanding links (live sessions die at
the gate, which re-reads the viewer row on every request). The mint response
carries the claim path `/invite/<token>` **exactly once** — the admin copies
it out of band. `deliverInvite` (routes/viewers.ts) is the one-function seam
where SMTP/ntfy delivery slots in later.

Visiting `GET /invite/:token` (public, per-IP rate-limited like
`/share/:token`) consumes the link atomically — used, expired, unknown,
malformed and revoked-viewer all answer the same 410, so a probe learns
nothing — issues a viewer session and 302s to `/`. Viewer sessions get their
own **90-day sliding TTL** (admin sessions keep 14 fixed days): a viewer
cannot log back in, their link was single-use, so an active viewer's session
renews itself whenever it has burned half its life, and only 90 days of true
absence ends it. The `__Host-` cookie pair is the same as the admin's, and
`GET /api/admin/me` answers a viewer session `authenticated: true` with
`principal: "viewer"` so the SPA can adapt. What a viewer reaches is the read
surface exactly as a token does — queries, sites, realtime, dashboards reads,
segment/goal/derived listings — scoped through the same `readableSites`
chokepoint; the whole `/api/admin/*` write surface answers 403.

**Users: password-holding accounts that own and manage sites (R23).** A user
is an email plus an owned site set (the `user_sites` join table; ownership
also grows atomically when the user creates a site, and a deleted site sheds
its owners). Managed admin-only: `GET /api/admin/users` lists them with their
sites, `POST /api/admin/users {email, sites?}` creates one — or re-invites an
existing email, restoring a disabled account — and mints a **single-use
invite link** (raw token `fsu_<43 base64url>`, sha256-at-rest, 7-day expiry)
whose claim path `/welcome/<token>` appears exactly once in the response;
`POST /api/admin/users/:id/invite` re-mints, which doubles as a password
reset (the old password works until the new link is claimed);
`PATCH /api/admin/users/:id {sites}` replaces the assignment;
`DELETE /api/admin/users/:id` disables — sessions and outstanding invites die
with it. `POST /claim/:token {password}` (public, rate-limited like
`/invite`; all failures one identical 410) consumes the link, sets the user's
first password and signs them in. From then on `POST /api/admin/login` with
`{email, password}` issues a user session — email absent still means the
instance admin's settings-row password, unchanged — and every user-login
failure answers the same 401 at the same one-scrypt cost, so the response
names no emails. User sessions share the admin's fixed 14-day TTL (they can
log back in). `GET /api/admin/me` answers `principal: "user"` plus `email`.
A user's viewer/token mints must fit inside their own sites (`'all'` or any
foreign site is a 400), and list/revoke see only their own mints
(`created_by_user_id`); grants stay fixed at mint — reassigning a site does
not shrink a standing viewer or token scope.

First-run setup (`POST /api/admin/setup`) additionally requires the one-time
**setup token** the server prints to its log at first boot: between `docker
run` and the owner opening the page, an unconfigured install is reachable by
anyone, and the token makes claiming it require console access. Setup and
login share the same rate limits (per-IP plus a global budget). The client
address comes from the `TRUSTED_PROXY_HOPS`-th `X-Forwarded-For` entry from
the end (default 1 — one trusted proxy); with `0`, forwarded headers are
ignored entirely.

## 6. MCP — analysts hook up their LLM

`POST /mcp` (outside `/api`) is a **streamable-HTTP MCP endpoint** on the same
process (`@modelcontextprotocol/sdk`, MIT), **stateless**: every POST
constructs its own server + transport and stands alone — no session id, no
handshake ordering, no load-balancer affinity. Responses are plain JSON
(`enableJsonResponse`), so a curl-shaped JSON-RPC POST is a complete client.

**Auth: the same Bearer API tokens, and ONLY those.** The route runs the
ordinary gate, then requires `principal.kind === 'token'`: anonymous is 401,
a cookie session is 403 — a Bearer token carries no ambient credential, so
there is no CSRF question, and MCP clients may be browser-based, so the route
gets the same CORS-on-Bearer treatment as `/api/query`. Site scoping is the
same `readableSites` chokepoint; an out-of-scope site answers like a
nonexistent one, as a tool-level error the model can read.

Two tools, deliberately few — the vocabulary is the product, and no free text
ever becomes SQL (invariant 9 holds because MCP is a thin shim over the closed
vocabulary):

- **`describe_analytics`** (no input) → one compact document: the sites this
  token reads (id/name/domains/timezone), every metric — built-ins from
  `MetricSchema`, live `goal:<id>:…` refs for goals on readable sites, live
  `d:<name>` derived metrics — every dimension (`BaseDimensionSchema` plus the
  `prop:<key>` keys actually in use per readable site), the filter grammar
  (ops, `all`/`any`/`not`/`segment`, `scope: "session"`, depth/leaf caps),
  range presets and `{from, to}`, compare forms, buckets, and the semantics
  notes (engagement-aware bounce, accrued attention, `~`-approximate
  distincts, the refusal philosophy). Every enumerable part is pulled from the
  live shared enums and DB rows, never restated — `routes/mcp.test.ts` asserts
  every `MetricSchema`/`BaseDimension` option appears, so the document cannot
  drift from what the query route accepts.
- **`query`** — the input schema **is `QueryRequestSchema`** (zod → JSON
  Schema via the SDK), executed through the same path as `/api/query`: segment
  expansion, derived/goal resolution, token scoping, and the same
  `ExecuteQuery` seam, so the worker read pool serves MCP too. Rate limiting
  shares the **same limiter instances** as the REST route: one
  30-batches/minute budget per token across both surfaces, one global bucket
  for the instance. Per-query `{error}` entries pass through verbatim —
  refusals teach the model the vocabulary's edges.
- **`what_changed(site, range, compare?)`** — sugar over the `changes` kind
  (§ 3), not a third path into the data: it composes the standard batch (the
  four default dimensions over `visits`, limit 8, plus the window totals),
  runs it through the SAME rate-limited, scope-checked seam as the `query`
  tool, and answers `{ summary, windows, rows }` — the rows verbatim, and a
  one-sentence natural-language summary produced by the same formatter the
  weekly digest uses (`query/changes.ts` § summarizeChanges), so the two
  surfaces can never phrase a movement differently. `compare` defaults to
  `"previous"` and accepts `"year"`; anything richer (other metrics, custom
  compare windows, filters) is what the `query` tool is for.
