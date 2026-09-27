# featherstat

A fast, small, self-hosted, multi-site web-analytics platform in TypeScript.

One process. One SQLite file. Matomo-compatible ingestion so existing tags keep
working unchanged. Dashboards that render in **one round-trip** instead of 36.

Built for personal-to-medium sites (a handful of sites, up to a few million
events/month) running on tiny hardware — the reference deployment target is a
shared-core cloud VM with 2 GB RAM that is already running eight other
containers.

## Why this exists

Matomo works, but it is a large PHP application: every dashboard widget is a
separate XHR, and every XHR is a full PHP bootstrap against a MariaDB server
that alone wants ~200 MB of RAM. Measured on the real deployment this replaces:
a single site dashboard fires ~36 API calls at 300–900 ms median each — 3–9 s
before the page settles, on a database whose *data* is tiny. The problem is
architecture, not volume. See [docs/01-context.md](docs/01-context.md) for the
measurements.

This project is a reimplementation of the parts actually used — multi-site
pageview/event analytics, realtime view with GeoIP, per-site and all-sites
dashboards — with none of the weight.

## Design principles

1. **One process, one file.** Node + SQLite (WAL). No database server, no
   Redis, no cron container, no worker fleet. Backup = one nightly
   `VACUUM INTO` copy, built in (never `cp` a live WAL file — see
   docs/09).
2. **A dashboard is one query.** The client sends a single batched query
   request describing every widget; the server answers all of them from SQLite
   in one read transaction. Target: p95 < 50 ms server-side on an e2-small.
3. **Drop-in for Matomo tracking.** Serves `/matomo.php` and `/matomo.js`
   (the subset that real sites use), so cutover requires **zero changes** to
   tracked sites — including server-side API hits.
4. **Cookieless and privacy-respecting by default.** Daily-rotating salted
   visitor hash; raw IPs are geolocated in memory and never stored.
5. **Everything is a widget.** Dashboards are JSON: a grid of
   `{query, viz, options}` cards. The built-in dashboards use the same
   mechanism as user-customized ones — customization is a first-class path,
   not an afterthought.
6. **Less code = less debt.** No plugin megasystem, no theming engine, no
   abstraction speculation. TypeScript end-to-end with shared types between
   server, tracker, and UI.

## What it is not (non-goals)

- Not a Matomo fork, and not full Matomo parity: no e-commerce, funnels,
  A/B tests, heatmaps, session replay, or tag manager.
- Not multi-tenant SaaS — but it is **multi-user**: one instance admin can
  invite users by email, each owning and managing only their own sites, plus
  read-only viewers, scoped API tokens, and share links. No role matrix
  beyond that.
- Not horizontally scalable: one node is the design point. SQLite is the
  ceiling and that ceiling is far above the target workload.

## Documents

| Doc | Contents |
| --- | --- |
| [01-context.md](docs/01-context.md) | The deployment being replaced, measured pain, requirements |
| [02-architecture.md](docs/02-architecture.md) | System design, tech stack decisions, performance budget |
| [03-data-model.md](docs/03-data-model.md) | Schema, visitor identity, sessionization, retention |
| [04-api.md](docs/04-api.md) | Matomo-compat tracking endpoint, native API, query API, SSE |
| [05-dashboards.md](docs/05-dashboards.md) | UI structure, widget system, chart design system |
| [06-migration.md](docs/06-migration.md) | Importing Matomo history; cutover plan |
| [07-roadmap.md](docs/07-roadmap.md) | Milestones M0–M3 with acceptance criteria |
| [08-implementation-plan.md](docs/08-implementation-plan.md) | Build order: work packages WP0–WP14, working agreement, pre-start decisions |
| [09-sqlite-contract.md](docs/09-sqlite-contract.md) | What a read-only reader of the SQLite file may rely on |
| [10-installing.md](docs/10-installing.md) | Installing the tracker on a site — the operator's guide |
| [adopter-review.md](docs/adopter-review.md) | An outside-in review: would someone else choose this? |
| [mockups/dashboard.html](mockups/dashboard.html) | Self-contained rendered mockup of the dashboard UI |

## Status

Running in production, six sites, since 2026-07-28. Milestones M0–M1 shipped
as v1; **v2 is current** — reached from a v1 database with one offline command
(`featherstat import v1 <path>`; stop v1 → import → start v2). What v2 added:

- **Query engine**: a worker-thread read pool (slow queries never block
  ingest), rollup tables with honest exact distincts, a nested filter grammar
  with saved segments and derived metrics, custom ranges + compare, and a
  server-side "what changed" ranking.
- **Event model**: custom props (capped, governed, scrubable), a campaign
  normalization + alias layer, goals as saved queries, tracker v2.
- **Data out**: scoped read-only API tokens (Bearer, CORS-enabled), CSV
  export, magic-link read-only viewers, an MCP endpoint (`/mcp`) so an LLM can
  query the same closed vocabulary, and a documented read-only SQLite contract
  (docs/09).
- **Operations**: dashboards as a library with shipped templates, site
  deletion (tombstone + chunked purge), retention that ages every table it
  should, and nightly `VACUUM INTO` backups configured from Settings → Data.

The brand mark and favicon sources live in `brand/`.

## Development

bun, never npm. Node ≥ 24.

```bash
bun install
bun run --cwd apps/server seed   # data/dev.db: 90 days × 6 sites, deterministic
bun run --cwd apps/server dev    # API on :8080
bun run --cwd apps/web dev       # dashboard on :5173, proxies /api to :8080
```

### The gates

```bash
bun run ci       # everything below, cheapest first; non-zero if any gate fails
```

| Gate | What it enforces |
| --- | --- |
| `bun run check` | biome lint + format, `tsc --noEmit`, `svelte-check` |
| `bun run build` | tracker bundles, SPA, esbuild server bundle |
| `bun run test` | vitest: units, the golden Matomo corpus, the replay assertions, and the tracker + web bundle-size ratchets |
| `bun run bench` | the replay perf budget (docs/02); thresholds in `apps/server/test/replay/bench-thresholds.json` |

The bundle budgets and the bench thresholds are **ratchets**: they tighten,
never loosen. A breach means the thing grew or slowed, not that the number was
wrong.

**The perf gates are local.** Their thresholds were measured on a dev machine
with just enough headroom to ignore its own scheduler, and a shared CI runner is
1.2–1.5× slower — there the budget reports the runner, not the code. Widening
the numbers to fit the slowest machine that might run them would forfeit exactly
the blowup they catch, so `bun run bench` and the two wall-clock assertions
marked `itWhereCalibrated` sit out under `$CI` (announced in the summary, never
silently). The trade is stated where it lives, in
`apps/server/test/replay/calibrated.ts`: a perf regression pushed without the
hook installed reaches `main` unchallenged.

Enable the hooks once per clone — on this project that is what runs the perf
gates at all:

```bash
git config core.hooksPath .githooks
```

`pre-commit` runs the fast gates (`bun run check`, ~5 s); `pre-push` runs the
whole of `bun run ci` (~25 s) — the same script
[GitHub Actions](.github/workflows/ci.yml) runs, bar those perf gates. Either
can be bypassed with `--no-verify` when you mean to.

## Deploy (Docker)

One container: SPA + query/admin API + tracking endpoints, SQLite on a volume.

```bash
docker build -t analytics .
docker run -d --name analytics -p 8080:8080 -v analytics-data:/data \
  -e TRUSTED_PROXY_HOPS=0 -e METRICS_TOKEN=change-me analytics
```

`TRUSTED_PROXY_HOPS=0` is right **only** for this bare `docker run`, with
nothing in front of the container. The image defaults to `1` for the Traefik
setup below; left at `1` with no proxy, the last `X-Forwarded-For` entry a
client sends is taken as its address — every visitor hash, login and claim
rate limit then keys on whatever the client typed. Behind a proxy, set it to
the number of proxies instead.

First boot opens the setup screen: choose the admin password and enter the
**setup token printed in the container log** (`docker logs analytics`) — proof
of console access, so a network scanner can never claim a fresh install.
Tracking endpoints and `/healthz` are public, everything else needs the session.

| Env | Default (image) | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `DB_PATH` | `/data/analytics.db` | SQLite file (put it on the volume). Outside the image it defaults to `data/dev.db`, the file `seed` writes |
| `TRUSTED_PROXY_HOPS` | `1` | Reverse proxies in front (each appends one `X-Forwarded-For` entry). `1` fits the Traefik setup below; `0` = no proxy, forwarded headers are ignored |
| `TRUST_X_REAL_IP` | unset | `1` = read `X-Real-IP` when a request carries no `X-Forwarded-For` — only if your proxy sets it (nginx `proxy_set_header X-Real-IP`); otherwise any client can send it |
| `GEOIP_MMDB_PATH` | `/data/dbip-city-lite.mmdb` | GeoIP database the refresh job maintains |
| `GEOIP_AUTO` | unset | `1` = download the GeoIP db when missing (a few hundred MB) |
| `METRICS_TOKEN` | unset | Bearer token for `/metrics`; unset = endpoint is a 404 |
| `MATOMO_FORWARD_URL` | unset | Tee mode: also forward every hit to a live Matomo (docs/06). Must be https, or loopback |
| `MATOMO_TOKEN_AUTH` | unset | `token_auth` sent at the bulk level of teed requests |
| `MATOMO_MYSQL_URL` | unset | Importer source DB (preferred over `--mysql-url`: command lines leak via `ps`/history) |
| `ASSETS_DIR` / `WEB_DIR` | `/app/tracker` / `/app/web` | Built tracker bundles / SPA (preset in the image) |
| `AUTH_DISABLED` | **never set** | Local-dev auth bypass; refused unless `NODE_ENV` is `development`/`test` |

Compose + Traefik (docs/02 § Security posture — TLS and the rate-limit
backstop live in Traefik):

```yaml
services:
  analytics:
    build: .
    restart: unless-stopped
    volumes: ["analytics-data:/data"]
    environment:
      METRICS_TOKEN: change-me
    labels:
      traefik.enable: "true"
      traefik.http.routers.analytics.rule: Host(`analytics.example.com`)
      traefik.http.routers.analytics.entrypoints: websecure
      traefik.http.routers.analytics.tls.certresolver: le
      traefik.http.services.analytics.loadbalancer.server.port: "8080"
volumes:
  analytics-data:
```

Operations: `GET /healthz` (liveness, used by the image HEALTHCHECK) and
`GET /metrics` (Prometheus text; `Authorization: Bearer $METRICS_TOKEN`).
Sessions, CSRF and the admin API are documented in docs/02 § Security posture
and docs/04 § 5. Backups are settings, not env: name a directory (on the
volume) in Settings → Data and the server writes a nightly `VACUUM INTO` copy
there, pruned to the newest N (docs/02 § Background jobs).

## License

MIT — see [LICENSE](LICENSE).
