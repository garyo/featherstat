# @analytics/web

The dashboard SPA: Svelte 5 (runes) + Vite, hand-rolled SVG charts, one
`/api/query` batch per view state. Design tokens live in `src/theme.css` and the
layout vocabulary in `src/lib/layout.css`, both taken from
[`mockups/dashboard.html`](../../mockups/dashboard.html) — the visual target.

## Dev environment

Two terminals, plus a one-time seed so there is data to draw.

```bash
bun install                                     # once, from the repo root

bun run --cwd apps/server seed                  # writes apps/server/data/dev.db (~6 s)

# terminal 1 — API on :8080 (opens the same data/dev.db the seed wrote)
bun run --cwd apps/server dev

# terminal 2 — dashboard on :5173, /api and /matomo.php proxied to :8080
bun run --cwd apps/web dev
```

`seed` replays the deterministic replay corpus (`apps/server/test/replay/generate.ts`,
docs/08 WP6) through the real parser, pipeline and batcher: 90 days of shaped
traffic for the six sites of docs/01, ending **today**, so every range preset
lands on data and "today" is a partial day. Re-running it rebuilds the file from
scratch. `DB_PATH` overrides the destination for both the seed and the server.

Two things the dev database deliberately lacks: geo columns (the corpus uses
RFC 5737 documentation IPs, which no `.mmdb` resolves) and live hits — to watch
SSE revalidation, POST to `/matomo.php` while the server is running:

```bash
curl -s "localhost:8080/matomo.php?idsite=4&rec=1&url=https://deep-timeline.org/timeline&send_image=0"
```

The `dev` script runs the server on Node (like `seed`): running it under the Bun
runtime crashes in better-sqlite3 (`NAPI FATAL ERROR`, seen with Bun 1.3.4).

## Layout

| Path | What |
| --- | --- |
| `src/lib/api.ts` | Query client: canonical request in, `QueryResponse` out; remembers each request's ETag and reuses the cached result on a 304. |
| `src/lib/live.ts` | `/api/realtime` EventSource wrapper (reconnect with backoff) + the revalidator that folds version ticks into one re-query. |
| `src/lib/state.ts` | View state ⇄ URL (pure). `state.svelte.ts` binds it to `history`, so back/forward and copy-link both work. |
| `src/lib/theme.ts` | Light/dark override, stamped as `data-theme` on `<html>` and remembered. |
| `src/lib/components/` | Shell chrome: header (tabs, theme toggle), filter row. |
| `src/widgets/` | The widget registry (viz type → Svelte component) and the hand-rolled SVG renderers: kpi-row, timeseries, bar-list, site-cards. |
| `src/views/` | The fetching layer: collects every widget query into one batch, runs it per view state, re-issues on debounced SSE version ticks. |
| `src/dashboards/` | The shipped default dashboards, as the same JSON documents user dashboards will be. |

Checks: `bun run --cwd apps/web check` (svelte-check) and `bun run test` from the
root — `src/lib/*.test.ts` run in the root vitest project.

## Status (WP9b)

The walking skeleton is live: the site overview (KPI row, visitors & pageviews
series, top pages, referrers) and the all-sites cards render from one
`/api/query` batch per view state, revalidate off SSE version ticks, and hold
the previous render at reduced opacity while refetching. Site names need an
admin API (WP13), so tabs and cards read `Site <id>` for now.
