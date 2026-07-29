# CLAUDE.md

Self-hosted multi-site web analytics in TypeScript: one Node process, one
SQLite file, Matomo-compatible ingestion, a batched one-request query API,
Svelte dashboards. **The design docs in `docs/` are the source of truth** —
read the relevant one before implementing in an area: 01 requirements ·
02 architecture/stack · 03 schema/sessionization · 04 APIs · 05 dashboards ·
06 migration · 07 roadmap · 08 build order (work packages WP0–WP14).

The project is named **featherstat** (chosen 2026-07-28). Package scope is
`@featherstat/*`; the brand mark and favicon sources live in `brand/`
(`brand/featherstat.svg` is the master — regenerate the PNGs with qlmanage
after edits and keep the a11y `<title>`).

## Commands (bun, never npm)

```bash
bun install
bun run check        # biome lint+format check, then tsc — green before every commit
bun run test         # vitest, all packages
bun run fix          # biome auto-fix
bun run --cwd apps/server seed  # seed data/dev.db (90 days × 6 sites, deterministic)
bun run --cwd apps/server dev   # dev API on :8080 (script runs Node: better-sqlite3
                                #   crashes under Bun 1.3.4 with a NAPI fatal error)
bun run --cwd apps/web dev      # dashboard on :5173, proxies /api to :8080
```

## Layout

- `apps/server` — Hono app: ingest routes, enrichment pipeline, sessionizer,
  batcher, query engine, SSE, jobs. Runs on Node ≥ 24; must stay
  bun-compatible (no Bun-only APIs).
- `apps/web` — Svelte 5 + Vite SPA (starts in WP9).
- `packages/shared` — zod schemas + constants. **The only cross-package
  import surface**; server/web/tracker define no duplicate cross-boundary types.
- `packages/tracker` — matomo.js compatibility shim + modern ESM tracker.

## Invariants (load-bearing — never violate)

1. **Widgets declare queries; views batch them.** One `/api/query` request per
   view state. Never per-widget fetching — that's the Matomo failure mode this
   project exists to fix.
2. **Single writer**: all DB writes flow through the ingest batcher's
   transactions. Reads from anywhere (WAL).
3. **Raw IP is transient.** Used for the visitor hash + GeoIP lookup in
   memory, then discarded. Never persisted, never logged, never in fixtures
   (scrub captured data to documented test IPs).
4. **Beacons never bounce.** Tracking endpoints ignore unknown params, record
   what they understood, and always answer fast (204 / GIF). 4xx to a browser
   beacon is a bug.
5. **Bounce is engagement-aware** (docs/03): 1 pageview AND no events AND
   `engaged_ms` < threshold. Don't reintroduce the naive definition anywhere.
6. **Ratchets only tighten**: the golden corpus
   (`apps/server/test/fixtures/matomo/`) and the perf thresholds only gain
   cases / get stricter. Never delete a fixture or loosen a threshold to make
   a change pass — surface the conflict instead.
7. **Everything rendered is a widget.** Anything that draws data belongs in
   `apps/web/src/widgets/`, registered in `registry.ts` and named in the
   shared `VizType` enum — so it is reusable on any dashboard, replaceable,
   and editable. A view supplies arrangement and shared interaction state
   (the Realtime page owns its layout and the highlight its tally and feed
   share); it never renders a widget's innards. A widget declares a query or
   declares none — the realtime family reads the SSE stream and asks the
   batch for nothing.

   Corollary — **one rendering per thing rendered**: never copy markup into a
   second file; extract it (`FeedRows.svelte`, `BarRows.svelte`) and let both
   callers render it. The realtime feed forked exactly this way, and every fix
   after that had to be made twice; `feed-rows.test.ts` now fails if a second
   file grows those rows.

   Known exception, deliberate: the Journeys sankey and flows table are still
   view-local (their edge-click and depth controls are coupled). Registering
   them is open work, not licence for the next one.
8. **Query vocabulary, never SQL from clients.** The compiler whitelists
   metrics/dimensions/ops; everything is parameterized.

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

`bun run check && bun run test` green before every commit. Self-review the
diff first: reuse, dead code, magic numbers, hot-path allocations. Perf
budgets from docs/02 are CI-enforced via the replay bench — treat a bench
regression like a failing test.
