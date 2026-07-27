# CLAUDE.md

Self-hosted multi-site web analytics in TypeScript: one Node process, one
SQLite file, Matomo-compatible ingestion, a batched one-request query API,
Svelte dashboards. **The design docs in `docs/` are the source of truth** —
read the relevant one before implementing in an area: 01 requirements ·
02 architecture/stack · 03 schema/sessionization · 04 APIs · 05 dashboards ·
06 migration · 07 roadmap · 08 build order (work packages WP0–WP14).

Project name is **undecided**. "Wakescope" appears only as the mockup
wordmark. Package scope `@analytics/*` is a placeholder. Never bake a name
into code, table names, or user-visible strings beyond the mockup.

## Commands (bun, never npm)

```bash
bun install
bun run check        # biome lint+format check, then tsc — green before every commit
bun run test         # vitest, all packages
bun run fix          # biome auto-fix
bun run --cwd apps/server dev   # dev server (bun runtime)
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
7. **Query vocabulary, never SQL from clients.** The compiler whitelists
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
