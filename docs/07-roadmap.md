# 07 — Roadmap

Four milestones, each independently shippable and each ending in something
running against real traffic. Parity before polish; polish before community.

## M0 — Walking skeleton

*Prove the spine: hit → SQLite → one-query dashboard.*

- Monorepo scaffold (bun workspaces, biome, vitest, shared zod schemas).
- `/matomo.php` for pageviews + events + pings → pipeline → batched SQLite
  writes; golden compat corpus started (R1 seed).
- `/api/query` with `visitors`/`pageviews`/`visits`, `day` bucket, `path`
  dimension.
- Throwaway single-page overview (KPIs + one time series + top pages) to
  prove the one-fetch rule end to end.
- Replay benchmark harness exists; perf budget wired into CI from day one.

**Accept when:** a synthetic 90-day, 6-site replay imports cleanly and the
overview renders in one query, < 50 ms server-side, on the e2-small.

## M1 — Parity (cutover-ready)

*Everything Matomo is actually being used for.*

- Full `/matomo.php` surface incl. bulk POST, outlinks/downloads, `matomo.js`
  shim; golden corpus complete.
- GeoIP enrichment + monthly refresh job; UA parsing; bot filtering +
  diagnostics counters.
- Realtime SSE: active counts, live feed, map data.
- Matomo importer + validation gate; tee mode.
- Real dashboards: All-sites (incl. per-site top-3 pages with trends, R20),
  Site view (KPI row, time series, pages, referrers, geo, devices, events,
  heatmap), Realtime view. Light + dark.
- Auth (single admin), sessions, first-run setup; Docker image + compose
  snippet; `/healthz` + `/metrics`.

**Accept when:** the bake (06-migration) runs 2 clean weeks on
`analytics.example.com` and daily numbers reconcile with Matomo within
documented deltas. **Then Matomo gets turned off.**

## M2 — The nice place to be

*The reasons to love it, not just tolerate it.*

- Dashboard edit mode: add/remove/resize/reorder widgets, query+viz picker,
  JSON export/import; share links (R13).
- Native ESM tracker (R14) + docs for adding a brand-new site in 5 minutes.
- Comparison ranges everywhere; click-to-filter chips; expand-with-table on
  every widget.
- **Journeys view** (R21): transitions sankey + top-flows table, built on
  the `seq` column and the sequence query kinds (03, 04).
- ntfy notifications: threshold spikes + chosen events (packzen signups)
  (R16).
- Litestream sidecar recipe (R17).

## M3 — Open source release

*Make it adoptable by strangers.*

- Name (see README), repo public, MIT license, README-driven docs: 10-minute
  quickstart (docker run → tracking snippet → dashboard), Matomo-migration
  guide generalized beyond this deployment.
- Config surface documented and frozen (env + settings table); versioned
  releases + published image; CI: lint, tests, palette validator, perf
  budget.
- Community hygiene: CONTRIBUTING, issue templates, a short architecture
  tour (02 condensed).
- Flourishes as time allows: realtime globe (R19, reusing globe-viz's
  three.js globe), weekly digest (R18).

## Sequencing notes

- The golden corpus (M0/M1) is the highest-leverage early artifact: it makes
  compatibility a regression suite instead of a hope.
- Rollup tables stay out of scope until a real deployment approaches ~10 M
  events (03) — the query vocabulary already leaves room for them.
- Nothing in M2/M3 blocks the personal cutover at end of M1; from M1 on, the
  project runs in production while it grows.
