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
| **Site** | The workhorse. Filter row (date presets, active dimension filters as removable chips; the compare mode is fixed to "previous period" until the compare toggle ships in **M2**) → KPI row → main time series → breakdown grid (pages, referrers, geo, devices, events, hours heatmap) → top journeys. Every breakdown row is click-to-filter; a filter on an event-level dimension renders the session-only KPI tiles (engagement, bounce) as "—" rather than erroring the row. |
| **Journeys** (per site) | R21. A sankey of the first N steps from the entry page (pages and events as nodes, edge weight = sessions) over a top-journeys table: sequence · sessions · avg time · exit rate. Clicking a sankey edge filters the table; the view honors the global filter row, so "journeys of visitors from HN" is one click. |
| **Realtime** | Active-now hero number, live feed, country tally of the last 30 minutes. Pure SSE, no queries. The world map with fading dots (city centroids) moved to **M2**: it needs the map-outline data that arrives with the sankey work, so M1 ships hero + feed + country list and the map joins when that asset lands. |
| **Settings** | Sites, tracking snippets, tokens, share links, retention, diagnostics (bot counts, ingest health). |

Single-page app; site switcher in the header; every view state (site, range,
filters) lives in the URL so views are linkable and back-button-correct.

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
  the same batch), `map` (world choropleth + city dots — **M2**, with the
  map-outline data that arrives alongside the sankey work), `feed` (realtime
  events). M2 adds the Journeys pair: `sankey` (transitions) + `flows`
  (top-journeys table). Later: `globe` — reusing globe-viz's hand-built
  three.js globe, not echarts-gl.
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
  columns), so "today" means the site's today.

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
