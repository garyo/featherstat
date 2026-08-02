# 08 — Implementation plan

The roadmap (07) says *what* ships in each milestone; this is the build order —
work packages sized to land as one focused session/PR each, every one ending
with tests green and something demonstrable. Order rationale: contract first,
then the data spine, then queries, then UI — each layer lands on a tested
substrate, and the golden corpus starts growing from the first line of parser
code.

## Phase 0 — Bootstrap

**WP0 · Repo.** Decide the name (front-runner: wakescope — claim the npm name
and domains when decided). `git init` in this folder (docs move to `docs/` as
already laid out), MIT LICENSE, README trimmed to the public-facing pitch.
GitHub repo, public from day one — cheaper than a later "open-sourcing" pass,
and it forces hygiene (no secrets, scrubbed fixtures) from the start.

**WP1 · Scaffold.** bun workspaces (`apps/server`, `apps/web`,
`packages/shared`, `packages/tracker`), strict shared tsconfig, biome, vitest,
GitHub Actions CI (typecheck + lint + test on Node 24; a bun-runtime job to
keep the compat promise honest).

**WP2 · The contract.** `packages/shared`: zod schemas for `Hit`,
`QueryRequest`/`QueryResponse`, `WidgetSpec`, dashboard JSON, config.
*Acceptance: schemas typecheck and round-trip; server/web/tracker all import
from here and nowhere else.*

## Phase 1 — Ingest spine (M0)

**WP3 · Storage.** SQLite via better-sqlite3: migrations runner
(sequential SQL files + `schema_migrations`), schema v1 from 03 (incl. `seq`),
WAL pragmas, typed data-access layer. *Acceptance: migration up from empty DB;
CRUD round-trips under vitest.*

**WP4 · matomo.php parser.** Query-string/form/bulk-JSON → normalized `Hit`.
The **golden corpus harness** starts here: fixtures in
`apps/server/test/fixtures/matomo/`, seeded with synthesized cases + real
access-log lines from the GCE server (run through a scrub script first — strip
IPs to documented test values, keep UA/param shapes). *Acceptance: corpus
green; unknown params provably ignored; `send_image=0` → 204.*

**WP5 · Pipeline.** validate → isbot → UA parse (LRU-cached) → GeoIP
(mmdb-lib against a small fixture .mmdb in tests) → sessionizer (in-memory
map, 30-min timeout, `seq`, `engaged_ms`, engagement-aware bounce inputs) →
200 ms batch writer. *Acceptance: sessionizer state-machine unit tests
(gap/timeout/ping/restart-recovery); crash-loss window ≤ one batch.*

**WP6 · Replay harness + perf gate.** Synthetic 90-day × 6-site traffic
generator piped through the real ingest path; asserts known totals; doubles as
the CI perf benchmark with thresholds (ingest hit cost, batch flush time).
*This is the M0 acceptance instrument — it exists before the query engine so
every later WP runs against realistic data.*

## Phase 2 — Query engine (M0)

**WP7 · Compiler + endpoint.** Query vocabulary → parameterized SQL with
snapshot tests; `POST /api/query` batch execution in one read transaction;
ETag = (site max rowid, schema version, body hash). *Acceptance: replay DB
answers the full 01-context widget set < 50 ms on dev hardware; 304 path
covered.*

**WP8 · Realtime hub.** SSE endpoint: snapshot + deltas + per-site
data-version ticks; ring buffer; Last-Event-ID resume. *Acceptance: two
subscribed clients see a POSTed hit and a version tick; resume works.*

## Phase 3 — Walking skeleton UI (M0 exit)

**WP9 · App shell.** Vite + Svelte 5 served by Hono; theme tokens (the
palette from 05/mockup, light+dark); layout chrome from the mockup. KPI row +
main timeseries + top-pages as real widgets on the one-fetch rule, SSE-driven
revalidation. Plain-SVG charts first (the mockup proves them); ECharts enters
only when a widget needs it (heatmap/map). *Acceptance = M0 exit: replayed
90-day data renders the overview in one query batch, live-updates on new
hits, light + dark.*

## Phase 4 — Parity (M1)

**WP10 · Tracker surface.** Full matomo.php coverage (outlinks/downloads,
ping, bulk POST) + `packages/tracker` matomo.js shim (< 3 KB gz, the `_paq`
subset from 01). Golden corpus completed from live access logs. *Acceptance:
a page using the real production snippet against a local server records
correctly, incl. heartbeat + SPA re-track.*

**WP11 · Enrichment jobs.** GeoIP monthly refresh (atomic swap +
previous-month fallback), bot/diagnostics counters, retention config
plumbing.

**WP12 · Dashboards.** The full 05 set: bar-lists everywhere, devices,
heatmap, realtime view (feed + map), all-sites cards (top-3 pages w/ trends,
goal pills). Site switcher, date presets, compare, click-to-filter chips.

**WP13 · Ops & auth.** Single-admin auth (scrypt via node:crypto — argon2id
would be the project's only native auth dependency; sessions, CSRF, first-run
setup), settings view, Docker image (< 120 MB), compose snippet +
Traefik labels, `/healthz`, `/metrics`.

**WP14 · Importer + cutover.** Matomo MariaDB importer (idempotent,
site ids preserved), validation gate vs Matomo's API, tee mode. Deploy on the
GCE host, import, bake 1–2 weeks per 06, reconcile, cut over. *M1 exit:
Matomo off.*

## Phase 5 — M2 (post-cutover, order by appetite)

Journeys (seq queries + sankey + flows table) · widget editor (code-split,
per 05 § cost analysis) with the widget chrome (`table` viz, expand,
copy-as-image, show-query) · goals + goal pills on site cards · compare
toggle · site delete · share links · native ESM tracker · ntfy notifications
· Litestream recipe.

## Working agreement

- One WP per session-ish unit; each ends green (typecheck, lint, tests,
  bench) and demoable. Review between WPs, not mid-WP.
- The perf gate (WP6) and golden corpus (WP4) are ratchets: numbers and
  fixtures only get added, never quietly relaxed.
- **Every ratchet is itself gated.** A guard's failure mode is silence — the
  web entry-size budget spent a month measuring `index-*.js` while the browser
  fetched four chunks, passing throughout, 11% over its own ceiling. So each
  guard exports its measurement (the `*.guard.ts` files), registers in
  `test/guards/inventory.ts` with at least one way to violate what it guards,
  and `test/guards/meta.test.ts` stages that violation and fails if the guard
  does not object. A new budget constant in a test, bench or guard file fails
  discovery until it carries a `@guard` tag and an inventory entry. The whole
  sweep is ~1.5 s; `GUARDS=cheap` drops the two that build an artifact to
  mutate, and the default runs everything.
- `0.x` versioning until cutover; no API stability promises before M2.
- Docs 01–07 are living: when implementation contradicts a design doc, the
  doc gets amended in the same PR.

## Decisions needed before WP0

1. **Name** — commit to wakescope (claim npm + domains), or start under the
   placeholder and rename before the repo goes public?
2. **Public from day one** — recommended above; veto if you'd rather bake
   privately through M0.
3. **Corpus source** — OK to pull scrubbed access-log lines from the GCE
   host for fixtures? (IPs replaced, UA strings kept.)
4. **Repo home** — `github.com/garyo/<name>`, or a fresh org for the project?

## v2 epilogue (2026-08)

WP0–WP14 shipped v1; this document stays as its record. The **v2 line** (on
the `worktree-v2` branch) was built in seven phases — foundations (schema
@ 100, epoch'd data version, worker read pool, principals), query language,
rollups, event model, data-out + viewers + MCP, analysis UX, and the v1
importer + ride-alongs (site deletion, retention completeness, backups) —
each phase landing with its ratchets per the working agreement above. What
shipped and how it behaves lives in [04-api.md](04-api.md) and
[05-dashboards.md](05-dashboards.md); CLAUDE.md carries the grown invariant
list (the epoch discipline is invariant 10, guarded by
`apps/server/test/guards/epoch.guard.ts`).
