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

A compatibility shim, **not** Matomo's 200 KB tracker — target < 3 KB gz. It
processes the standard `_paq` queue and implements exactly the used surface:

`trackPageView`, `trackEvent`, `trackLink`, `enableLinkTracking`,
`enableHeartBeatTimer`, `disableCookies` (no-op — always cookieless),
`setTrackerUrl`, `setSiteId`, `setCustomUrl`, `setDocumentTitle`,
`setReferrerUrl`.

Unknown `_paq` commands log one `console.debug` and are ignored. Delivery via
`navigator.sendBeacon` with fetch-keepalive fallback. Heartbeat: focus-gated
15 s ping, exactly like the tags expect. No SPA auto-tracking here — the blog
already re-pushes on `astro:page-load` and the shim must not double-count.

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

- `packages/tracker` ships `tracker.js` (< 2 KB gz, ESM):
  `init({site, endpoint})`, auto pageviews with a `history` hook (opt-out),
  auto outlink/download, focus-gated engagement pings, `track(name, props?)`.
  CORS: `Access-Control-Allow-Origin: *` on collect only.
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

Response: `{ results: { [id]: { rows, compare? } | { error } }, meta: { generatedInMs, dataVersion } }`.
A query the vocabulary cannot answer honestly (e.g. `bounce_rate` × `title`) or
a kind that ships in a later milestone yields a per-query `error` entry — the
batch itself still succeeds, and never returns wrong numbers.

- **Vocabulary, not SQL.** Metrics: `visitors`, `visits`, `pageviews`,
  `events`, `engaged_ms`, `bounce_rate` (engagement-aware — see 03),
  `views_per_visit`, `event_value_sum`. Dimensions: `path`, `hostname`, `title`, `ref_domain`,
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
  visitors from HN" is just a filter).
- **Click-to-filter falls out for free**: clicking a row in any breakdown adds
  a `filters` entry and re-issues the same batch.
- **Caching**: response ETag = hash(max event rowid, schema version,
  canonicalized request body, resolved per-site date windows — so a preset
  like `today` expires at site-local midnight even when no data changed).
  Unchanged data → 304 with zero queries executed. Realtime SSE tells the
  client *when* to revalidate, so there's no polling loop.
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
