# CLAUDE.md

Self-hosted multi-site web analytics in TypeScript: one Node process, one
SQLite file, Matomo-compatible ingestion, a batched one-request query API,
Svelte dashboards. **The design docs in `docs/` are the source of truth** —
read the relevant one before implementing in an area: 01 requirements ·
02 architecture/stack · 03 schema/sessionization · 04 APIs · 05 dashboards ·
06 migration · 07 roadmap · 08 build order (WP0–WP14; both carry a v2
epilogue) · 09 the read-only SQLite contract · 10 installing the tracker
(the operator's guide; § 3 is the 404 trap).

The project is named **featherstat** (chosen 2026-07-28). Package scope is
`@featherstat/*`; the brand mark and favicon sources live in `brand/`
(`brand/featherstat.svg` is the master — regenerate the PNGs with qlmanage
after edits and keep the a11y `<title>`).

## Commands (bun, never npm)

```bash
bun install
bun run ci           # every gate: check, build, test, bench — green before every push
bun run check        # biome lint+format check, then tsc — green before every commit
bun run test         # vitest, all packages
bun run e2e          # Playwright over the built app (test/e2e); NOT in `ci`
bun run e2e:install  # once per clone: playwright install chromium
bun run bench        # replay perf budget (runs Node, see below)
bun run fix          # biome auto-fix
bun run --cwd apps/server seed  # seed data/dev.db (90 days × 6 sites, deterministic)
bun run --cwd apps/server import -- --help      # Matomo importer (docs/06)
bun run --cwd apps/server import -- v1 <path>   # one-shot v1→v2 rewrite (stop v1 first)
bun run --cwd apps/server dev   # dev API on :8080 (script runs Node: better-sqlite3
                                #   crashes under Bun 1.3.4 with a NAPI fatal error)
bun run --cwd apps/web dev      # dashboard on :5173, proxies /api to :8080
```

## Layout

- `apps/server` — Hono app: ingest routes, enrichment pipeline, sessionizer,
  batcher, query engine (`query/`, worker read pool in `query/pool/`), rollup
  write/rebuild/verify (`rollup/`), SSE, jobs, importers (`import/` Matomo,
  `import/v1/` the v1→v2 rewrite). Runs on Node ≥ 24; must stay
  bun-compatible (no Bun-only APIs).
- `apps/web` — Svelte 5 + Vite SPA (starts in WP9).
- `packages/shared` — zod schemas + constants, plus the shipped dashboard
  templates (`templates/`) the server and web both resolve. **The only
  cross-package import surface**; server/web/tracker define no duplicate
  cross-boundary types. Every consumer declares it as a `workspace:*`
  dependency and resolves it through its `package.json` `exports` — no path
  aliases, so a new entry point is one line there.
- `packages/tracker` — matomo.js compatibility shim + modern ESM tracker.

## Invariants (load-bearing — never violate)

Ten, numbered because the code cites them by number — the numbers are stable
even as the prose shrinks. **An invariant a test enforces is documentation; one
enforced only by memory is a liability.** Six have a guard now and are one line
each: go read the guard, it is the source of truth and this is a map to it. Four
are still memory, in whole or in part, and those are spelled out — that is the
list to actually hold in your head.

### Enforced — the guard is the source of truth

- **2 · Single writer**: writes only inside `withWriteTransaction`, reads from
  anywhere (WAL). Every write helper calls `assertWritable`, which throws on a
  write outside a transaction — so this fails loudly rather than corrupting.
  (Residue: a *new* write helper still has to make that call.)
- **4 · Beacons never bounce**: ignore unknown params, record what was
  understood, answer fast (204 / GIF). 4xx to a browser beacon is a bug. Every
  case in `apps/server/test/fixtures/matomo/` asserts its own status and not one
  is a 4xx; `routes/track.test.ts` covers the oversize body and the hit nothing
  understood; the `auth/app.test.ts` route matrix keeps them public.
- **5 · Bounce is engagement-aware** (docs/03). One definition, `bounce_rate` in
  `query/compiler.ts`, with the threshold bound rather than inlined; the naive
  definition fails `executor.test.ts` "an engaged single-page session is NOT a
  bounce", which exists to say so.
- **8 · The alias name is a label, never a key**: group by the visitor's opaque
  `ref`; the two-word name exists to be read. `lib/realtime.test.ts` expects
  maps keyed by `ref`, so keying on the name fails them. (Residue: no branded
  type, so `tsc` would still allow it.)
- **9 · Query vocabulary, never SQL from clients.** The zod enums 400 anything
  outside the vocabulary; `compiler.test.ts` proves no filter value reaches the
  SQL text and every op binds its parameters; `routes/query.test.ts` sends
  `'; DELETE FROM events; --` through the live route and checks the table
  survived.
- **10 · Every history rewrite bumps `data_epoch`.** `dataVersion` is
  `epoch·2⁴⁰ + MAX(events.id)`, so an in-place rewrite that skips the bump
  leaves every pre-rewrite ETag answering 304 forever. Current rewriters:
  campaign, referrer and timezone backfills (each including its post-backfill
  rollup rebuild), prop scrub, site purge, and reconcile's drift repair (bump
  conditional on having repaired — a clean nightly run costs the caches
  nothing). **"Having repaired" is durable, not per-run**: the backfills set a
  dirty setting in the same transaction as the row they change and clear it
  only after the bump (`settleRewrite` in `jobs/rewrite.ts`), because a run
  that crashes mid-rewrite and resumes into a remainder needing no change
  would otherwise skip the bump it owed.
  `apps/server/test/guards/epoch.guard.ts` scans every job source under
  `src/jobs/` and objects to a rewriter without the bump — or a new job that
  rewrites events/sessions or rebuilds rollup days unregistered; the
  meta-guard proves the scan binds. (Residue: a rewriter outside `src/jobs/`
  is outside the scan — today the Matomo importer, which bumps once its dirty
  sites' rollups are rebuilt.)

### Memory — no guard, or only half of one

- **1 · Widgets declare queries; views batch them.** One `/api/query` request
  per view state. Never per-widget fetching — that's the Matomo failure mode
  this project exists to fix. *Guarded*: `collectBatch` lives in
  `packages/shared`, so server and client cannot build different batches
  (`views/batch.test.ts`, `layout.test.ts`, and the batch invariants the
  dashboard write path validates), and `apps/web/src/widget-io.test.ts` refuses
  any file under `widgets/` that calls `fetch`, imports `lib/api`, `lib/admin`
  or `lib/live`, or opens a stream. Widgets read `env` and nothing else; wanting
  a query client inside one means the view is wrong. *Unguarded*: that a view
  sends one request per state — nothing stops a view splitting its batch.
- **3 · Raw IP is transient.** Used for the visitor hash + GeoIP lookup in
  memory, then discarded. *Guarded half*: no column holds one, and
  `realtime/hub.test.ts` proves nothing IP-shaped reaches the wire. *Unguarded
  half, and the reason this stays long*: never logged, never in a fixture —
  scrub captured data to the documented test ranges (192.0.2.x / 198.51.100.x /
  203.0.113.x). Nothing scans for a leak.
- **6 · Ratchets only tighten**: the golden corpus
  (`apps/server/test/fixtures/matomo/`), the perf thresholds, and the
  rollup-vs-raw equivalence corpora
  (`apps/server/test/replay/rollup-equivalence.test.ts` and
  `rollup-read-equivalence.test.ts` — the flush path must agree with a
  recompute from raw, and the rollup read route with the raw one, adversarial
  fixtures included) only gain cases / get stricter. Never delete a fixture or
  loosen a threshold to make a change pass — surface the conflict instead.
  **Permanently memory**: a test cannot object to being edited, so nothing here
  can ever enforce this one (`test/guards/meta.test.ts` catches a guard that
  silently stops binding, but not a deliberate edit).
- **7 · Everything rendered is a widget.** Anything that draws data belongs in
  `apps/web/src/widgets/`, registered in `registry.ts` and named in the shared
  `VizType` enum — so it is reusable on any dashboard, replaceable, and
  editable. A view supplies arrangement and shared interaction state (the
  Realtime page owns its layout and the highlight its tally and feed share); it
  never renders a widget's innards. A widget declares a query or declares none —
  the realtime family reads the SSE stream and asks the batch for nothing.
  *Guarded*: `widgets/env.test.ts` makes every `VizType` declare what it needs
  and keeps the stream readers out of the batch, and the corollary — **one
  rendering per thing rendered** — is now a table in
  `apps/web/src/ownership.test.ts` (markup → the one file allowed to own it).
  Extract and decorate; never teach a second file the markup. Registration is
  typed: `registry.ts` must cover every `VizType` not on its `PLANNED` list, so
  an unregistered viz fails the type-check. *Unguarded*: that a new drawing file
  lands in `widgets/` and becomes a `VizType` at all. The Journeys sankey and
  flows table are the standing exception (their edge-click and depth controls
  are coupled) — open work, not licence for the next one.

## Conventions

- TS strict, ESM only, no `any`, no default exports. zod-validate at every
  boundary: HTTP bodies, JSON columns, config, tracker input.
- **License discipline**: MIT project — dependencies must be
  MIT/BSD/Apache-compatible. Known trap: `ua-parser-js` must stay on **v1**
  (v2 relicensed AGPL).
- Timestamps are UTC ms; `local_date`/`local_hour` are computed at ingest
  from the site's IANA timezone (docs/03).
- Comments only for constraints the code can't express; match surrounding
  style; no change-narration comments.
- Tests live beside the code they test (`*.test.ts`) and land in the same
  change. The sessionizer and query compiler carry the heaviest test burden.
- When implementation teaches us the design doc is wrong, amend the doc in
  the same change.

## Quality bar

`bun run check && bun run test` green before every commit, `bun run ci` — which
adds the build and the replay perf bench — green before every push. Self-review
the diff first: reuse, dead code, magic numbers, hot-path allocations. Treat a
bench regression like a failing test: the docs/02 perf budgets are gated, not
advisory.

The gates run themselves if you enable the hooks once per clone:
`git config core.hooksPath .githooks` (pre-commit → `check`, pre-push → `ci`).
`.github/workflows/ci.yml` runs the same `bun run ci` on push and PR — **bar the
perf gates**, which are calibrated to a dev machine and would measure a 1.2–1.5×
slower runner instead of the code. `bun run bench` and the two assertions marked
`itWhereCalibrated` skip under `$CI` (loudly, in the summary). The reasoning,
and the cost, live in `apps/server/test/replay/calibrated.ts`. The consequence
worth holding: **the pre-push hook is the only thing enforcing perf**, so a
clone without it can land a regression.

**`bun run e2e` is deliberately outside `bun run ci`** (`test/e2e`, ~35 s): run
it after touching anything the browser renders. It is out of `ci` so the pre-push
gate stays fast, which is what keeps it being run at all; GitHub Actions runs it
as its own `e2e` job beside the gates, uploading the Playwright report and
traces when it fails. It exists because `ci` was green through every UI defect of
the v2 bake — nothing type-checks how a template stringifies a value, so the
gap was never unit coverage but that **nothing opened the app**. Its
`nonsense.spec.ts` sweep — no screen may render `[object Object]`, `undefined`,
`NaN` or `null` — is the cheapest guard here and the one that pays: it catches a
whole class on screens nobody wrote an assertion for.
