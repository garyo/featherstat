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

## Deferred by decision — returning visitors and cohorts

**Not a gap to close casually; a trade to make deliberately.** Gary wants to
know whether deep-timeline and globe-viz get returning readers, and someday may
turn this on for those sites. Deferred 2026-07-30 rather than dropped, with the
reasoning recorded so it is not re-derived.

The daily-rotating salt makes cross-day identity **cryptographically
impossible**, not merely unimplemented: the previous day's salt is destroyed, so
nothing can link Monday's visitor to Tuesday's. Retention needs exactly that
link. Cohorts and cross-day unlinkability are mutually exclusive, and no tool
has both:

- **Plausible** uses our exact construction (`hash(daily_salt + domain + ip +
  ua)`, rotated and destroyed every 24 h) and states it cannot offer
  new-vs-returning or retention.
- **Matomo's** cohort analysis rides the persistent `_pk_id` cookie. In
  cookieless mode its `config_id` seed also regenerates every 24 h, and its
  docs list cohort analysis, returning-visitor counts and multi-session
  attribution as losing accuracy. Same boundary; opposite default.

So the shape is a **per-site policy**, not an architecture change — Matomo makes
it a per-install choice and we would make it per-site, defaulting to the strict
setting so a site needs no consent banner unless it opts out.

What exists already: `uid` opt-in (`pipeline/identity.ts`) hashes a
site-provided user id with a stable per-site salt, off by default. **A site with
logins has full cohort capability today** — and it costs nothing in privacy
terms, because that site already knows who the user is.

What it would take, beyond the setting itself: retention cards and their query
kinds, and — the part that must not be skipped — a way for the UI to say WHICH
kind of count it is showing. One site's `visitors` would mean people; another's
means visitor-days. The `measures` header (`unit`/`population`/`aggregate`) is
where that belongs, and the approximation mark already exists for it. Shipping
the setting without that distinction would recreate defect 13 across sites
instead of across screens.

Cheaper and available now, and often what "cohorts" actually means to the
asker: segment-over-time (traffic from one referrer, week over week) needs no
identity at all and is a filtered query.

## Sequencing notes

- The golden corpus (M0/M1) is the highest-leverage early artifact: it makes
  compatibility a regression suite instead of a hope.
- Rollup tables stay out of scope until a real deployment approaches ~10 M
  events (03) — the query vocabulary already leaves room for them.
- Nothing in M2/M3 blocks the personal cutover at end of M1; from M1 on, the
  project runs in production while it grows.

## v2 epilogue (2026-08)

The roadmap above is v1's, kept as written. A **v2 line** exists on the
`worktree-v2` branch: a clean-slate schema (user_version 100) reached by
`featherstat import v1`, plus the four redesigned pillars — query engine
(worker-thread read pool, rollups with honest distincts, filter grammar v2,
segments, derived metrics), event model (props, campaign layer, goals,
tracker v2), auth & data-out (scoped API tokens with CORS + CSV, magic-link
viewers, the `/mcp` endpoint), and analysis UX (dashboard library, detail
views, pivots, custom ranges/compare, "what changed", annotations, alerts).
Ride-alongs: site deletion, retention completeness, nightly `VACUUM INTO`
backups. The query and dashboard surfaces are specified in
[04-api.md](04-api.md) and [05-dashboards.md](05-dashboards.md), which are
maintained to match.

**Multi-user (2026-08, R23)**: the auth pillar grew a fourth principal — user
accounts that log in with email + password (claimed by single-use invite
link), each owning and fully managing its own set of sites, with the admin
wall split into a manager surface and an admin-only surface
(04-api.md § 5). The instance admin's settings-row password and the
read-only viewer/token principals are unchanged.
