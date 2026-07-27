# analytics-new (working title)

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
   Redis, no cron container, no worker fleet. Backup = copy one file.
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
- Not multi-tenant SaaS: one admin, optional read-only share links. No RBAC.
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
| [mockups/dashboard.html](mockups/dashboard.html) | Self-contained rendered mockup of the dashboard UI |

## Name

**Undecided** — the folder name and the "Wakescope" wordmark in the mockup are
placeholders only; the repo stays local-git until a real name is chosen, then
goes public on GitHub. Availability notes (checked 2026-07-27, npm + DNS):
free on npm — wakescope (+ .com/.dev unregistered), taffrail, trafficscope,
viewscope; taken/crowded — webscope (Yahoo), sitescope (Micro Focus),
spyglass, skopos. Don't bake any placeholder name into code.

## Status

Implementation in progress — M0 (walking skeleton), following
[docs/08-implementation-plan.md](docs/08-implementation-plan.md).

## License

MIT — see [LICENSE](LICENSE).
