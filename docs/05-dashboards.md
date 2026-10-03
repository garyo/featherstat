# 05 — Dashboards

The UI is the reason this project exists — Matomo's data was fine; its
dashboards were slow, dated, and rigid. The design goals, in order: fast,
legible, customizable.

The rendered mockup at [`mockups/dashboard.html`](../mockups/dashboard.html)
is the visual reference for everything below (both views, light and dark).

## Information architecture

| View | Contents |
| --- | --- |
| **All sites** (home) | One card per site: name, active-now, today's visitors + delta ("today" = the SITE's local today, per its timezone), a compact line chart of visitors over the range (zero-based, labeled y-axis, date labels and the hover tooltip — it is the page's main content, so it is a chart, not a sparkline), the site's **top 3 pages with per-page trend** (micro-sparkline + delta vs previous period — how each blog article is doing, at a glance, R20), and goal/event pills (e.g. "3 signups today" — **M2**, alongside goals themselves). A site with no traffic yet gets a "waiting for the first hit" card, not a blank. Sorted by traffic. The whole view is one `/api/query` batch + the SSE stream. |
| **Site** | The workhorse. Filter row (date presets — Today · Last 24 hours · 7 / 30 / 90 days · Month to date, the second of which is the rolling window whose comparison is like-for-like, 04 § 3 — active dimension filters as removable chips; plus an explicit date range and the compare control — see § Custom ranges & compare) → KPI row → main time series → breakdown grid (pages, referrers, geo, devices, events, outbound links, time on page, hours heatmap) → top journeys. Every breakdown row is click-to-filter; a filter on an event-level dimension renders the session-only KPI tiles (engagement, bounce) as "—" rather than erroring the row. |
| **Journeys** (per site) | R21. A sankey of the first N steps from the entry page (pages and events as nodes, edge weight = sessions) over a top-journeys table: sequence · sessions · avg time · exit rate. Clicking a sankey edge filters the table; the view honors the global filter row, so "journeys of visitors from HN" is one click. **A step is a move, not a hit**: a page repeated back to back — reloaded, or announced twice by an SPA router — is one step, so no edge loops a node back to itself and no journey reads `/app → /app` (03 § Journeys, 06). A session that never left its entry page is a one-step journey with no edges, and shows up in the table rather than the sankey. |
| **Realtime** | Active-now hero number, a per-visitor tally of the last 30 minutes (alias · hits · engaged time · place · site — the time is the server's, since only it sees the heartbeat pings), live feed, country tally of the same window. Pure SSE, no queries. The world map with fading dots (city centroids) moved to **M2**: it needs the map-outline data that arrives with the sankey work, so M1 ships hero + feed + country list and the map joins when that asset lands. |
| **Settings** | Every admin surface, behind a section nav: Sites & tracking (sites CRUD, snippet, password) · Access (API tokens, viewers) · Users (admin-only) · Query objects (segments, derived metrics, goals) · Campaigns (registry, aliases, UTM link builder) · Notifications (ntfy, alert rules) · Data (prop governance, annotations, diagnostics). See § Settings. |

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

## Settings

One code-split chunk (never on the dashboard path), organized as a section nav
so the admin surfaces stay small panels instead of one wall. The nav is
role-filtered: a user (R23) gets the per-site sections (Sites & tracking,
Access, Query objects, Campaigns — minus the admin-only cards: segments,
derived metrics, campaign aliases); Users, Notifications and Data are the
admin's alone, and a viewer gets no ⚙ at all. The open section is view state
like any other — `?view=settings&section=access` — so a reload stays put and
Back returns to the previous section. Any move that would take a panel's
unsaved edits off screen asks first — another section, Back, a header control,
Log out, a reload — the same question the dashboard editor asks of its draft.
Every irreversible row verb (revoke, delete, disable, reset) takes a second
click on the same button, which lapses after a few seconds:

| Section | Panels |
| --- | --- |
| **Sites & tracking** | Sites CRUD, the tracking snippet, password change. Users see and manage only the sites they own (R23); the admin sees all. |
| **Access** | API tokens and viewers — the two read-only principals (04 § 5). Both mints show their secret (the bearer token, the `/invite/…` magic link) exactly once, with a copy button and a "you will not see this again" line; the lists that follow show only names, scopes and dates. A user's mint form offers only their own sites (no all-sites option), and their lists hold only their own mints. |
| **Users** (admin-only) | Password-holding accounts that own and manage sites (04 § 5, R23): invite by email (the `/welcome/…` claim link shows once), site assignment, re-invite (doubles as a password reset), disable. |
| **Query objects** | Segments, derived metrics, goals — the stored vocabularies queries reference as `{segment: id}`, `d:<name>`, `goal:<id>:…`. Segments and goals share the filter editor of § The filter editor: rows of dim/op/value that AND together, an "Edit as JSON" mode, and **Build visually…**, which opens the same expression editor the dashboard filter row does. The row mode round-trips only trees it can represent — anything richer opens in JSON, never silently flattened. A stored filter carries no segment ref (04 § 3), so no segment picker is offered here. |
| **Campaigns** | The registry (`campaign_status` reads it at query time), the alias lists (per-site and install-wide site 0; saving is a full-list replace and warns that history is rewritten), and a client-only UTM link builder that suggests registered campaigns and flags values ingest would normalize (via the shared `canonicalUtmValue`). |
| **Notifications** | The ntfy endpoint + per-hit rules, and the alert rules evaluated hourly — together because both deliver through the same endpoint. |
| **Data** | Prop governance (key stats, clamp counters, and a two-step delete that says it scrubs history), annotations, storage diagnostics. |

The panels are static imports inside the settings chunk, deliberately not
per-section `import()` sub-chunks: a dynamic import inside a non-entry chunk
splits vite's preload helper and the entry-shared modules into preloaded
siblings — first-load bytes the budget above does not have. The panels' admin
client lives in `lib/admin-objects.ts`, built on `AdminClient.call`, so its
forty routes ride this chunk and not the entry (`lib/admin.ts` is on the login
path). Its route strings are pinned to the server's by a contract test.

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
  period, 12-point sparkline labelled with its peak and zero — the line is
  zero-anchored, and the peak beside it is what separates a bump of two from a
  bump of two thousand. An intraday range
  takes the companion hourly, every metric included, since sessions carry
  `local_hour` from schema 104. Day buckets are not the fallback: across `24h`'s
  local midnight they draw two points spanning `24 − h` and `h` hours, which
  slopes with the clock rather than the traffic. A period the measure cannot
  reduce — a bounce rate over an hour with no visits — is a GAP in the line,
  never a zero), `timeseries` (line/area, ≤ 4 series),
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

### The dashboard library

A scope has a **library** of dashboards, not a singleton: the shipped
templates plus any number of stored rows. Shipped templates live in
`packages/shared/src/templates/` as typed factories — `overview`, `content`,
`acquisition`, `campaigns` for a site, `all-sites` for the overview — shared
because the server needs them too (reset rebuilds a clone from its template).
A template is code, not a row: it builds at the current vocabulary on every
call and appears in the library as a virtual entry.

- **URL**: `?dash=<rowId>` or `?dash=t:<templateId>` joins the view state.
  Absent means the scope's **default**: the oldest stored row if any — exactly
  the pre-library singleton rule, so an untouched install sees no change —
  else the shipped overview / all-sites template.
- **Switcher**: a `<select>` in the Shell header beside the scope picker, fed
  by the same store the view renders from. Its "Manage dashboards…" line opens
  the management panel (new/rename/duplicate/reset/delete), a code-split chunk.
- **Templates are immutable; editing clones.** Opening the editor on a
  template reads "Customize"; the first save creates a stored row recording
  `dashboards.template` — the lineage that powers **reset** (rebuild the
  clone's layout from its template, keeping the row's name). Rows created from
  scratch have no template and refuse reset.
- **Duplicate** copies a row (fresh identity, template lineage carried, no
  share links — links point at rows). **Delete** removes the row and revokes
  its share tokens in the same transaction; the list shape carries a live
  `shareCount` so the delete confirm says what it will revoke first.

### Detail views (drilldowns)

A breakdown row whose dimension has an **entity template** — `path`,
`ref_domain`, `utm_campaign` (`DETAIL_DIMENSIONS`) — drills on its primary
click: `?view=detail&d=<dim>:<encoded value>` joins the view state, and the
view renders `DashboardGrid` over the template built for that entity
(`@featherstat/shared/detail-templates`: `pageDetail`, `referrerDetail`,
`campaignDetail`). Invariants 1 & 7 hold: ordinary widgets, one batch. The
page template leans on the phase-2 vocabulary — adjacency (previous/next
pages), `dwell.path`, per-page `distribution` histograms, entry/exit KPIs and
a `scope:'session'` referrer list.

- **The binding is per-widget, shown as a locked chip.** No single
  request-level filter can say "hits on this page" AND "sessions containing
  it" AND "sessions entering at it" at once, so each widget's query carries
  its own binding; the filter row wears one locked (visible, not removable)
  chip naming the entity, and the view's ordinary removable chips compose on
  top — they ride the request's `filters` exactly as on a dashboard.
- Detail templates are **code, not library entries**: versionless, rebuilt at
  the current vocabulary on every visit, no `t:` ref, nothing to clone. They
  live behind the `detail-templates` subpath export so the code-split detail
  chunk — not the entry — carries them (build.guard markers prove it).
- Per-site only (like Journeys): entering at All-sites coerces to the
  last-visited site. Back is `history.back()` — a drill pushes history. The
  filter icon on a drillable row keeps click-to-filter reachable.

### The filter editor

The filter row's chips are removals only; building an expression opens the
editor (`lib/components/FilterEditor.svelte`, code-split, one mount in the shell
for every view that carries chips, and mounted again by Settings' query objects).
It says everything the grammar says: nested `all`/`any` groups, a NOT flag on any
group, per-condition **whole visit** scope, and a saved segment as a condition.

- **"Whole visit" is offered only where it changes the answer.** `scope:
  'session'` means "the visit containing this hit has ≥1 non-ping event
  matching" — so filtering `event_action = add_to_cart` unticked keeps the click
  and nothing else, while ticked keeps that visit's whole path through the site.
  That distinction exists only for dimensions the sessions table does NOT carry
  (`variesWithinSession` in `packages/shared`): for country, browser, device,
  referrer or campaign the visit has one value and both scopes agree, so the box
  is hidden rather than offered as a no-op. It reappears when already ticked, so
  a scope set from text or a URL can always be seen and undone.

- **It edits a draft, not the wire shape.** `lib/filter-tree.ts` holds a
  `DraftNode` tree — a group carries `negated` as a flag rather than a `not`
  wrapper, every node carries an `id` so editing one condition cannot steal
  focus from another, and a half-typed condition is legal. `nodesOf` is the one
  place a draft becomes `FilterNode[]`; it refuses (naming the path) rather than
  dropping. Removing a group's last condition removes the group; a group opened
  with "+ group" and left empty is unfinished work and says so.
- **The caps are the editor's, not the server's** (`MAX_FILTER_DEPTH`,
  `MAX_FILTER_LEAVES`, `MAX_FILTER_NODES` in `packages/shared`): a tree the UI
  offered to build must never come back as a 400.
- **The plain-English reading** under the editor is `chipLabel` over the whole
  expression as one node — labelling each top-level node separately and joining
  on "and" loses the parentheses that make `a and (b or c)` unambiguous.
- **Naming an expression stores it as a segment**, and the URL can then carry
  `f=segment:<id>`. Offered to everyone and refused by the server for a
  principal who may not write one, exactly as the ⚙ Settings tab already is.

**Text mode** ("Edit as text") is a second way to *say* the same draft, never a
second place to keep it — `lib/filter-text.ts` prints the draft and parses it
back, and `root` stays the one source:

```
country != "SG" and (path contains "/blog" or path starts "/docs")
not (segment "Paying customers" or session path = "/pricing")
```

`not` binds tighter than `and`, which binds tighter than `or`. Values may be
bare (`country != SG`) unless they collide with a keyword; the printer always
quotes, so its output is stable and `parse(print(x)) === x` for every tree — the
property that makes the toggle lossless. Typing is forgiving where reading is
not: `is` / `is not` / `starts with` all work, and keywords are case-insensitive.

A refusal names the character it stopped at and **keeps the text on screen** —
losing a half-written expression to a typo is the failure mode this mode would
otherwise have. Applying from text parses first and refuses to close on junk.

The vocabulary reference under the box is generated from the same zod enums the
parser validates against (`dimensionReference`, `OPERATOR_REFERENCE`), so it
cannot drift from what is actually accepted, and it names each dimension —
nobody guesses `ref_domain` from "Referrer". Values have no completion: the
editor cannot know a country is `SG` rather than "Singapore". Open work.

**The `f` param** takes one top-level node per entry, in three spellings:
`dim:op:value` (unchanged, so every link written before the editor still
parses), `segment:<id>`, and `~<base64url JSON>` for anything the flat spelling
cannot say — a group, or a leaf naming `scope`. Everyday filters stay legible in
a shared URL; only the expressions that need it go opaque.

### Pivots & per-widget filters

- **Pivot** = a transient overlay swapping one bar-list's breakdown:
  repeatable `pv=<widgetId>:<dim>` URL params, applied by `applyPivots`
  (web `lib/pivots.ts`) to derive the document BEFORE `collectBatch`, so the
  one-fetch rule holds trivially and derived companions recompute. The card
  title becomes a `<select>` of the base dimensions valid for the widget's
  metrics (a dim that would block every metric is not offered; a partial
  block is trimmed like any chip). Pivots are dropped on a scope or library
  change (they name widgets of that document) and **ignored by share links**
  — the share route assembles its batch from the stored row. Keeping a pivot
  is saving it: the editor opens on the pivoted document, so "Customize/Edit
  → Save" persists it.
- **Per-widget filters** are first-class in the schema — on **every** query
  shape, metric and kind alike, merged AND with the view's chips (docs/04 § 3).
  Two scroll histograms filtered to different countries are two different
  questions, and the `kind` queries once dropped theirs silently.
  The editor's WidgetSettings carries a filter-row editor for metric queries
  (dim/op/value over the shared vocabulary; eq/neq/contains in the UI, the
  schema accepts more) in its own lazy chunk; a kind query takes its filters
  from a template or the JSON editor. A scoped widget of either shape wears a
  **"filtered" badge** in view
  chrome whose tooltip lists its filters in chip words; a contradiction with
  the view's chips renders honestly empty with both in sight.
  `withoutBlockedMetrics` judges blocked combinations **per query** — the
  view's chips plus the widget's own filters plus its (possibly pivoted)
  grouping dims — so a page-scoped widget loses its bounce column while the
  card beside it keeps every metric.

### What changed & annotations

- The `changes` viz renders the server's `changes` kind (docs/04 § 3): per
  scanned dimension, the top movers by |delta| between the compare windows,
  as a compact signed-bar list (current count, delta bar, share of the net
  change in the tooltip; rise/fall in the status colors WITH a sign glyph).
  It ships on the overview template under the KPI row. It requires `compare`:
  at `cmp=off` the server's refusal renders like any per-query error card.
- **Annotations**: a view whose dashboard contains a timeseries widget sets
  `annotations: true` on its batch (opt-in, so an annotation edit only
  expires ETags of dashboards that show one); `meta.annotations` flows into
  the widget environment beside `windows`, and Timeseries draws a small
  marker on the bucket each note's instant falls in (site-local, the same
  clock→bucket derivation as the axis trim), with the text joining the
  existing hover tooltip. Authoring UI is Phase-6d settings work.

### Custom ranges & compare

The range row's presets are joined by an explicit range (`range=<from>..<to>`
in the URL, two native date inputs in the UI — no picker library; the bundle
ratchet is a design constraint) and a compare control:
`cmp=previous|year|off|<from>..<to>`, default `previous` (the pre-control
behavior). `off` omits `compare` from the batch. Labels come from one module
(`lib/state.ts`): explicit ranges read as dates ("Jun 1 – Jun 30, 2026"), and
an unequal-length custom compare states BOTH lengths ("compared with May 1 –
May 14, 2026 (30 days vs 14 days)") — rows align by index from the start
(docs/04 § 3), and that labeled mismatch is what keeps the alignment honest.
A single-day explicit range is intraday: day buckets rewrite to hours exactly
as `today` does. Share links keep their preset-only knob.

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
  the tile reads `—` forever. The second (v2 → v3) adds `avg_engagement`, once
  the tile stopped dividing and started reading the metric; the same rule, one
  vocabulary change later. The editor's add-widget factory builds through both,
  so a new widget is born current instead of being upgraded on its first read.
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

The bundle claim above is enforced by `apps/web/src/build.test.ts`, over the
**whole first-load module graph** — every script `dist/index.html` fetches
before first paint, not the entry chunk alone. That distinction is load-bearing:
rollup hoists what the entry shares with the split chunks into preloaded
siblings, so a budget naming one file drifts away from what a browser actually
downloads, and this one silently did. Ceiling 80 KiB gz against ~71 KB today;
the editor, settings, share page and share dialog keep their own budgets and
must stay off this path (asserted by marker strings that exist only in them).

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
color never carries the sign alone.

**A widget does no metric arithmetic.** It reads the result's `measures` header
(04 § 3) and lets the declaration decide:

- **How the number is written** comes from `unit`. A `rate` arrives as 0–1 and
  is multiplied by 100 in exactly one function, so a tile and its own sparkline
  cannot disagree about the scale — the bounce tile wrote `31%` while its
  sparkline computed `31` and would have written `3100%`.
- **How buckets combine** comes from `aggregate`. A sparkline slice is the
  measure's value for ONE bucket of that slice, never the slice's total: sums
  and distinct counts reduce to their per-bucket mean, ratios re-divide their
  declared components, and a slice that cannot be reduced drops the whole line
  rather than drawing a fabricated point.
- **What has no total at all** is `distinct`. The all-sites cards used to sum
  per-day visitor counts into a headline while the same site's KPI tile counted
  the range once — two screens, two numbers, one label. The cards now read a
  per-site range total from the batch; the day buckets are the chart's points
  and nothing else. Anything else asking for a total of a distinct measure gets
  `undefined` and has to say so.

"Unique visitors" is labeled as exact per-day, approximate across ranges (see 03
— identity): every figure drawn from a `distinct` measure wears the `~` mark and
its explanation, on the KPI tile's label and the site card's caption alike, from
the aggregate rather than from the metric's name.

**A delta on a partial range compares against a complete one, and says so.**
`today` at 09:00 is 9 hours of traffic against all 24 of yesterday, so its
tiles read low all morning; the filter row states the comparison in words
("compared with all of yesterday") rather than letting the arrow imply a drop
that is really a clock. The fix is a range, not a smaller yesterday: **Last 24
hours** compares 24 hour buckets against the 24 before them, which is
like-for-like by construction (04 § 3). Clipping the calendar presets instead
would make "yesterday" mean "yesterday until 09:00" — the same misreading,
pointing the other way, and invisible.

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
reachable without a pointer: bar-lists and KPI tiles are text; the line
chart, heatmap, histogram and sankey each carry a visually-hidden table of
exact values (`widgets/DataTable.svelte`, the one rendering of it), and the
line chart is also a focus stop whose arrow keys step the hover crosshair
bucket by bucket; the sortable `table` viz (M2) becomes the universal
fallback when it lands. In edit mode a card's drag handle moves it with the
arrow keys (Home/End to the ends) and announces its new position.
Legends always present for ≥ 2 series; single series titled, unlegended.
Color-blind safety is enforced by the palette validator in CI (the palette is
data, so the check is automatable); texture fill available as the opt-in
backup channel.
