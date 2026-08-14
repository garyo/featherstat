# 01 — Context and requirements

What exists today, what is actually used, what is measurably wrong with it, and
what the replacement must therefore do. Everything in this document is measured
from the live deployment and the tracked sites' repos as of 2026-07-27.

## The deployment being replaced

- **Matomo 5** (`matomo:5-apache`) + **MariaDB**, docker-compose on a GCE
  **e2-small** (2 shared-core vCPUs ≈ 0.5 vCPU sustained, 2 GB RAM) shared with
  a reverse proxy and several other containers.
- GeoIP: **DB-IP City Lite** `.mmdb`, monthly cron refresh, re-selected via UI.
- Archiving: `core:archive` cron every 15 min (Matomo pre-aggregates reports).
- The Matomo database is tiny — data volume has never been the problem.

## Measured pain (2026-07-25, logged-in UI, Resource Timing)

| Dashboard | API calls | median | max | page settled |
| --- | --- | --- | --- | --- |
| pcons.org | 35 | 453 ms | 2.9 s | 4.1 s |
| oberbrunner.com | 36 | 396 ms | 4.1 s | 7.1 s |
| globe-viz | 36 | 566 ms | 4.2 s | 7.9 s |
| deep-timeline | 36 | 873 ms | 5.8 s | 9.1 s |
| All Websites | 7 | 2 ms | 95 ms | 1.4 s |

Diagnosis: **chattiness × per-request latency**. Each widget is its own XHR and
each XHR is a full PHP bootstrap. "All Websites" is fast *because* it is only 7
calls. Additionally `mariadbd` sits ~190 MB into swap on this host permanently.

Two architectural conclusions fall straight out of this:

1. A dashboard must be **one request**, not N.
2. The storage engine must be **in-process** (no separate DB server competing
   for RAM on a 2 GB box).

## The six tracked sites

Site IDs are load-bearing — tags and one server-side integration reference them
by number, and the importer must preserve them.

| id | Site | Notes |
| --- | --- | --- |
| 1 | pcons.org | |
| 2 | oberbrunner.com + blog.oberbrunner.com | blog is an alias URL; Astro blog re-tracks on `astro:page-load` |
| 3 | globe-viz | |
| 4 | deep-timeline.org | |
| 5 | pelorus-nav.com | two documents: app shell + landing page |
| 6 | packzen.org | server-side signup event (see below) |

## What is actually used (from the repos, not the feature list)

Every site's snippet is the same shape:

```js
_paq.push(['disableCookies'])            // all sites — cookieless everywhere
_paq.push(['enableHeartBeatTimer', 15])  // all sites — engagement time
_paq.push(['trackPageView'])
_paq.push(['enableLinkTracking'])        // outlinks + downloads
_paq.push(['setTrackerUrl', 'https://analytics.example.com/matomo.php'])
_paq.push(['setSiteId', '<n>'])
// then async-load https://analytics.example.com/matomo.js
```

Plus one **server-side tracking call** — packzen's Clerk webhook posts signups:

```
GET /matomo.php?idsite=6&rec=1&e_c=signup&e_a=account-created&send_image=0
→ must return 204
```

Features in real use, and therefore the compatibility surface:

- Pageviews, page titles, SPA re-tracking (custom URL/title per client-side nav)
- Events (category / action / name / value)
- Heartbeat pings for time-on-page / engagement (15 s, focus-gated)
- Link tracking: outlinks and downloads
- Cookieless visitor identification (config/fingerprint-based)
- GeoIP to city level; realtime visitor view with geo
- All-sites overview + per-site dashboards
- Referrers incl. search/social classification; campaign params

Matomo features **not** used (and not carried over): goals/funnels, e-commerce,
site search, custom dimensions, segments, user IDs, tag manager, A/B, consent
manager. (Matomo's role matrix is not carried over either — featherstat grew
its own, simpler multi-user model later: R23.)

## Requirements

### Must have (parity — cutover requires these)

- **R1** Accept the exact tracking traffic above at `/matomo.php` with zero
  site changes; serve a working `/matomo.js` implementing the used `_paq`
  subset. `send_image=0` → 204.
- **R2** Multi-site with numeric site IDs preserved (1–6 today; new sites get
  the next id).
- **R3** Pageviews, events, outlinks/downloads, heartbeat-derived engagement.
  Bounce must be engagement-aware: a single-page session with real dwell time
  or an event is **not** a bounce (a deliberate break from Matomo — reading
  one article to the end is engagement, not failure).
- **R4** GeoIP city-level enrichment from a local `.mmdb` (DB-IP City Lite),
  with built-in monthly refresh.
- **R5** Realtime view: active visitors now, live event feed with geo.
- **R6** All-sites overview + per-site dashboards; referrer classification;
  device/browser/OS breakdowns.
- **R7** Import full history from the Matomo MariaDB.
- **R8** Run comfortably on the e2-small next to everything else:
  single container, < 100 MB RSS, no separate DB server.
- **R9** Cookieless by default; raw IPs never stored.

### Should have

- **R10** Dashboard p95 server time < 50 ms; page interactive < 1 s.
- **R11** Custom dashboards: add/remove/rearrange widgets, saved server-side,
  exportable as JSON.
- **R12** Dark mode (selected palette, not a CSS invert).
- **R13** Read-only share links per dashboard.
- **R14** A modern ESM tracker for new sites (the Matomo shim is for
  continuity, not the future).
- **R15** Prometheus `/metrics` + `/healthz` (the home stack already runs
  Prometheus + Grafana).
- **R20** All-sites cards surface each site's **top 3 pages with trends**
  (delta vs previous period) — per-article blog tracking at a glance.
- **R21** **Journeys**: per-site common event sequences — entry page → steps
  → exit, with session counts, time spent, and events along the way.
- **R22** **Live by default**: every dashboard view updates itself as hits
  arrive (SSE-driven revalidation), not just the Realtime page. The
  performance budget makes this the normal mode, not a special one.

### Nice to have

- **R16** ntfy webhook notifications (traffic spikes, chosen events like
  signups) — an ntfy server is already deployed.
- **R17** Litestream streaming backup of the SQLite file to GCS.
- **R18** Weekly email/ntfy digest.
- **R19** A realtime globe view (an homage to globe-viz).
- **R23** **Multi-user**: the instance admin can invite users by email; each
  user owns a set of sites (including any they create) and fully manages
  them — dashboards, goals, campaigns, annotations, tracker snippet, and
  viewer/token invites scoped within them — while seeing nothing of anyone
  else's. One admin, no role matrix beyond admin/user/viewer/token.

## Constraints

- TypeScript throughout; **bun** as package manager/tooling; runs on
  Node ≥ 24.
- Open source (MIT), developed in the open as a general-purpose tool — the
  deployment above is the reference install, not the only install.
- Simplicity is a feature: prefer deleting a requirement to adding a moving
  part.
