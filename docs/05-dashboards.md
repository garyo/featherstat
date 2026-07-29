# 05 — Dashboards

The UI is the reason this project exists — Matomo's data was fine; its
dashboards were slow, dated, and rigid. The design goals, in order: fast,
legible, customizable.

The rendered mockup at [`mockups/dashboard.html`](../mockups/dashboard.html)
is the visual reference for everything below (both views, light and dark).

## Information architecture

| View | Contents |
| --- | --- |
| **All sites** (home) | One card per site: name, active-now, today's visitors + delta ("today" = the SITE's local today, per its timezone), 14-day sparkline, the site's **top 3 pages with per-page trend** (micro-sparkline + delta vs previous period — how each blog article is doing, at a glance, R20), and goal/event pills (e.g. "3 signups today" — **M2**, alongside goals themselves). A site with no traffic yet gets a "waiting for the first hit" card, not a blank. Sorted by traffic. The whole view is one `/api/query` batch + the SSE stream. |
| **Site** | The workhorse. Filter row (date presets, active dimension filters as removable chips; the compare mode is fixed to "previous period" until the compare toggle ships in **M2**) → KPI row → main time series → breakdown grid (pages, referrers, geo, devices, events, outbound links, time on page, hours heatmap) → top journeys. Every breakdown row is click-to-filter; a filter on an event-level dimension renders the session-only KPI tiles (engagement, bounce) as "—" rather than erroring the row. |
| **Journeys** (per site) | R21. A sankey of the first N steps from the entry page (pages and events as nodes, edge weight = sessions) over a top-journeys table: sequence · sessions · avg time · exit rate. Clicking a sankey edge filters the table; the view honors the global filter row, so "journeys of visitors from HN" is one click. |
| **Realtime** | Active-now hero number, a per-visitor tally of the last 30 minutes (alias · hits · engaged time · place · site — the time is the server's, since only it sees the heartbeat pings), live feed, country tally of the same window. Pure SSE, no queries. The world map with fading dots (city centroids) moved to **M2**: it needs the map-outline data that arrives with the sankey work, so M1 ships hero + feed + country list and the map joins when that asset lands. |
| **Settings** | Sites, tracking snippets, tokens, share links, retention, diagnostics (bot counts, ingest health). |

Single-page app. The header is **Scope × View**: one scope picker (All sites
| each site) beside three view tabs (Dashboard | Journeys | Realtime) —
"overview" is simply Dashboard at All-sites scope. Scope changes keep the
view and view changes keep the scope, with the one undefined cell resolved
explicitly: Journeys has no All-sites rendering, so entering it at All
coerces the scope to the last-visited site (the picker truthfully wears it),
and choosing All while on Journeys lands on the overview. Realtime at All
scope badges every feed/tally row with its site. Every view state (site,
range, filters, view) lives in the URL so views are linkable and
back-button-correct; the realtime feed also survives server restarts (the
hub ring boot-seeds from the newest stored events).

## The one-fetch rule

A view issues exactly one `/api/query` batch per (site, range, filters) state,
plus the one long-lived SSE connection. Interactions that change state (new
range, added filter) re-issue the batch. While refetching, charts hold their
previous render at reduced opacity — no skeletons, no layout shift.

## Live by default (R22)

Every view is live, not just Realtime. The SSE stream carries each site's
data-version; when a hit lands for the site being viewed, the client
debounces a few seconds and re-issues its query batch — cheap by construction
(< 50 ms server-side, or a 304 if the change didn't touch this view's range).
Counters that can update optimistically (active-now, today's totals, the
feed) tick straight from the SSE payload and reconcile on the next batch. No
polling, no manual refresh, no stale dashboard left open overnight. This is
downstream of the performance budget: when a full refresh costs tens of
milliseconds, "live" stops being a feature and becomes the default.

## Widgets

A dashboard is JSON: a grid of widget cards.

```jsonc
{
  "name": "deep-timeline overview",
  "site": 4,
  "grid": [
    { "w": 12, "h": 1, "viz": "kpi-row",
      "query": { "metrics": ["visitors", "pageviews", "engaged_ms", "bounce_rate"] } },
    { "w": 12, "h": 2, "viz": "timeseries", "title": "Visitors & pageviews",
      "query": { "metrics": ["visitors", "pageviews"], "bucket": "day" } },
    { "w": 6, "h": 2, "viz": "bar-list", "title": "Top pages",
      "query": { "metrics": ["pageviews"], "dim": "path", "limit": 10 } },
    { "w": 6, "h": 2, "viz": "bar-list", "title": "Referrers",
      "query": { "metrics": ["visitors"], "dim": "ref_domain", "limit": 10 } }
  ]
}
```

- **Viz types (v1)**: `kpi-row` (stat tiles: value, signed delta vs compare
  period, 12-point sparkline — omitted on a single-day range, where session
  metrics like `engaged_ms`/`bounce_rate` cannot be bucketed by hour, so
  `today` has no honest intraday companion), `timeseries` (line/area, ≤ 4 series),
  `bar-list` (the Plausible-style ranked list with inline bars — the
  workhorse for every breakdown), `table` (sortable — **M2**, with the widget
  editor; until then every chart carries its own accessibility fallback, see
  § Accessibility), `heatmap` (hour × weekday), `devices` (the
  mockup's stacked device bar + browsers list — one card, two breakdowns of
  the same batch), `dwell` ("Time on page": the `dwell` kind's pages ranked by
  average measured dwell, each behind a wash bar, with the longest view and the
  count of *measured* views alongside — the card states what its average rests
  on, and says plainly when nothing could be timed),
  `map` (world choropleth + city dots — **M2**, with the
  map-outline data that arrives alongside the sankey work), `feed` (realtime
  events). M2's journeys (sankey over transitions + top-journeys flows table)
  shipped as the dedicated per-site **Journeys view** (see the IA table above)
  rather than as `sankey`/`flows` viz types: the pair is one coupled
  interaction (a clicked edge filters the table from the same batch) with its
  own depth control, which a free grid placement would break apart. Widget-ized
  journeys can join the vocabulary later if a standalone card earns its keep.
  Later: `globe` — reusing globe-viz's hand-built three.js globe, not
  echarts-gl.
- **The built-in dashboards are just shipped JSON files** — the default
  site-overview is the same document a user's customized dashboard is. Edit
  mode: add/remove/resize/reorder cards, pick query + viz from the same
  vocabulary the API speaks. Export/import = copy the JSON.
- Every widget offers: expand (full-width with table view), copy-as-image,
  and "show query" (the JSON it sent — self-documenting API). This widget
  chrome ships in **M2** with the code-split editor chunk it belongs to.
- **Everything is a widget, including the all-sites view**: a site card is
  just a `site-card` widget with its own settings (sparkline range, how many
  top pages, which goal pills, and **sort order** — traffic (default, with
  site-id tiebreak so order is always deterministic), fixed by site id, or
  name), so selecting/editing/reordering works there with the same mechanism
  as everywhere else.

### Layout versions

A saved dashboard is a client-authored query plan the server executes later —
on the detail route and behind a public share link — so the metric vocabulary
it names can move under it. Every layout carries a `version` and is carried
forward on read:

- **The field is liberal.** Absent (every row written before versioning) or
  unreadable both read as version 1, never as a validation failure: a stored row
  is a boundary, and refusing one strands a dashboard nobody can repair. A
  version *newer* than the running build is answered as it stands — a rollback
  must not blank a dashboard.
- **The upgrade is a sequence of small steps**, one per vocabulary change, in
  `packages/shared/src/layout.ts`. A change appends a step; it never edits a
  landed one, because rows written against that step still exist. The first step
  (v1 → v2) gives a KPI query naming `engaged_ms` the `engaged_sessions` its
  avg-engagement tile divides by — the metric added in f47d1e5, without which
  the tile reads `—` forever.
- **Reads never write.** `readStoredDashboard` is the one path from the
  `dashboards.layout` column to a `Dashboard`, and it upgrades in memory only.
  Share links are read-only and public: rewriting a row from a GET there would
  put an anonymous reader on the single-writer path (docs/02) that ingest needs,
  and bump the write counter every cache revalidation keys off. Rows converge
  instead on their next *save* — the admin write path applies the same steps
  before storing, so an older client's save lands at the current version.

### What editability costs at runtime

Nothing measurable on the view path, provided one invariant holds:
**widgets declare queries; the *view* collects and batches them.** A widget
never fetches for itself — per-widget fetching is exactly how Matomo ended up
at 36 XHRs per dashboard. With the invariant intact:

| Cost center | Impact |
| --- | --- |
| Query work | Unchanged — the batch contains whatever widgets exist; a default dashboard and a customized one are the same shape. Editing one widget's settings previews with a batch of one; saving returns to the single view batch. |
| Render | A registry (`viz` type → Svelte component) instantiated from the dashboard JSON — this is how the view would be built even without editability. Component lookup + props is nanoseconds against a 16 ms frame. |
| Load | One extra small read: the dashboard JSON (a few KB, ETag-cached). |
| Persistence | Saving an edit writes one row. Nothing on the read path changes. |
| Bundle | **The only real cost, and it's avoidable**: drag-reorder, settings panels, and the query picker live in a code-split editor chunk loaded on entering edit mode. The view path ships zero editor code. Drag uses native pointer events + CSS transforms (no DnD library, no reflow during drag). |
| Complexity | The honest price: the widget spec becomes a versioned public contract — zod-validated, migrated when options change, unknown `viz` types rendered as a placeholder card rather than breaking the dashboard after an upgrade. |

Guardrails so a hand-built dashboard can't hurt: a widget cap per dashboard
(24), the existing per-query vocabulary limits, and a per-batch time budget
with per-widget timing surfaced in "show query" — so if someone builds a
40-widget, 5-year dashboard, it degrades to ~100–200 ms and *tells you why*,
instead of failing.

## Chart design system

Charts follow the dataviz method (form → color-by-job → validated palette →
mark specs → hover layer → accessibility pass). Its parameters are encoded
once in `apps/web/src/theme/` as CSS custom properties + an ECharts theme, so
every chart inherits them. The mockup instantiates all of this.

- **Palette**: the validated reference palette — categorical slots in fixed
  order (blue, orange, aqua, yellow, …), assigned by entity, never cycled;
  sequential = blue ramp light→dark (bar-lists, heatmap, choropleth);
  status colors reserved for health/deltas, never series. Dark mode is a
  **selected** palette (own steps per slot, validated against the dark
  surface), not an inversion — wired via `prefers-color-scheme` +
  `data-theme` override.
- **Marks**: 2 px lines, area fills ≈ 10 % opacity washes, bars ≤ 24 px with
  4 px rounded data-ends, 2 px surface gaps between touching marks, hairline
  solid gridlines, recessive axes. Text always wears text tokens, never
  series color.
- **Hover layer by default**: crosshair + all-series tooltip on time series;
  per-mark tooltips with generous hit targets on bars/cells/dots. Tooltips
  enhance, never gate — every value is also reachable via direct labels or
  the table view. All labels rendered via `textContent` (they're visitor-
  controlled strings).
- **Series discipline**: ≤ 4 series on shared-axis charts, fold to "Other"
  past that; all-pairs forms (map, scatter) cap at 3 or go single-hue
  sequential. Never a dual axis — two scales means two charts. Sankey links
  encode magnitude, not identity: single-hue sequential washes with node
  labels in ink — never one color per path.
- **Time series x-axis** buckets by the site's timezone (the `local_*`
  columns), so "today" means the site's today — and the axis is **the server's**,
  not the browser's. A widget reads `result.axis` (per site) and `meta.windows`
  off the response it was handed (04 § 3) and zips its sparse rows against them;
  it resolves no presets and enumerates no buckets. The one thing a browser still
  owns is the READER's clock: an axis is trimmed to whichever is newer, the
  server's `clip` or the bucket the reader is in, so a dashboard left open lets
  `today` grow as the hour turns and a 304 revalidation still moves. That single
  trim carries the DST tests, because it is now the only place a client turns a
  clock into a bucket.

  The consequence worth naming: the in-app dashboard, the editor preview and the
  public share page cannot disagree about the window on screen, because none of
  them derives it. The share page has no site directory and so could never
  resolve a preset — it used to fall back to the *data extent*, which is why the
  same widget code rendered two different window semantics depending on which
  page it was on.

## Numbers

Compact display (`12.9K`, `4.2M`) with exact values in tooltips and tables;
`tabular-nums` only in table columns and axis ticks; deltas signed with
direction-×-goodness color (bounce-rate down = green) plus an arrow glyph, so
color never carries the sign alone. "Unique visitors" is labeled as exact
per-day, approximate across ranges (see 03 — identity).

## Responsive & performance

- Grid: 12 columns desktop → 6 tablet → 1 mobile (cards stack in reading
  order). The realtime map degrades to the country bar-list on small screens.
- Budget (from 02): < 200 KB gz initial JS. ECharts loads per-chart via
  dynamic import; the KPI row and bar-lists are plain Svelte + SVG (no chart
  engine), so first paint never waits on canvas code.
- Interactive < 1 s on the reference host; the query batch itself is < 50 ms.

## Accessibility

Keyboard: every interactive mark reachable (`tabindex` + focus tooltip);
filter row and tables fully keyboard-native. Every chart's values are
reachable without a pointer: bar-lists and KPI tiles are text, the heatmap
carries a visually-hidden table of exact values; the sortable `table` viz
(M2) becomes the universal fallback when it lands.
Legends always present for ≥ 2 series; single series titled, unlegended.
Color-blind safety is enforced by the palette validator in CI (the palette is
data, so the check is automatable); texture fill available as the opt-in
backup channel.
