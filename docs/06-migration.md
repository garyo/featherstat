# 06 — Migration from Matomo

Goal: full history preserved, zero tag changes, zero data gap, and a cutover
that is boring. Matomo stays untouched until the new system has proven itself
on live traffic.

## Importer

`analytics import matomo` — a one-shot CLI in `apps/server`, reading the
Matomo MariaDB directly (over the Docker network or an SSH tunnel; read-only
credentials).

| Matomo source | Destination | Notes |
| --- | --- | --- |
| `matomo_site` | `sites` | ids preserved verbatim (R2); alias URLs → `domains` |
| `matomo_log_visit` | `sessions` | `idvisitor` (8 bytes) → `visitor_id`; `visit_first_action_time`/`visit_last_action_time` → timestamps; `visit_total_time` → `engaged_ms` (best available proxy); `location_country/region/city` + lat/lon; `config_browser_name/os/device_type/resolution`; referrer fields → attribution |
| `matomo_log_link_visit_action` ⨝ `matomo_log_action` | `events` | pageviews, events (category/action/name/value), outlinks, downloads; `server_time` → `ts`; page URL/title from the joined action rows |

Import details:

- `local_date`/`local_hour` recomputed from each site's timezone during
  import (Matomo stores UTC; same convention).
- Historical visitor ids don't chain with the new daily-rotating scheme —
  fine: unique-visitor counts are per-day-exact in both systems, which is the
  only guarantee we make anyway (03).
- Idempotent: source rows carry their Matomo ids in a scratch mapping table
  during import, so re-running tops up instead of duplicating. This enables
  the final top-up import at cutover.
- Validation gate: for three spot-check months, per-site daily
  visits/pageviews from `/api/query` must match Matomo's API within rounding.
  Known definitional deltas (bot filtering, ping handling) get documented
  numbers, not hand-waving.

## Live-traffic bake: tee mode

Before cutover, the new server runs with `MATOMO_FORWARD_URL` set: every hit
accepted at `/matomo.php` is **also forwarded verbatim** (async,
fire-and-forget, with the original client IP in `cip` + `token_auth`) to the
real Matomo. Then DNS/Traefik for `analytics.example.com` is pointed at
the new server:

- Sites need no changes at any point (R1).
- Matomo keeps recording everything, so it remains the fallback source of
  truth during the bake.
- The new system sees 100 % of real production traffic — realtime, geo,
  quirky UAs, the packzen webhook — for as long as confidence requires.

If the new system misbehaves: point Traefik back. Blast radius ≈ zero.

## Cutover sequence

1. Deploy the new container on the GCE host (Traefik labels, new internal
   hostname), run the importer, eyeball dashboards against Matomo.
2. Enable tee mode; repoint `analytics.example.com` to the new server.
   Bake for 1–2 weeks; compare daily numbers.
3. Cut over: final top-up import (fills the pre-tee gap exactly), disable
   tee, stop the Matomo + MariaDB containers (compose entries commented, data
   kept — same reversible pattern used when Umami was retired).
4. After a quiet month: `mysqldump` archived off-host, containers removed,
   `matomo.example.com` router alias retired, MariaDB's ~190 MB of swap
   reclaimed.

## Post-cutover deltas to expect

- Bounce/engagement improve in honesty: heartbeat-based engagement replaces
  Matomo's "0 s unless a second action happened", and **bounce rate will read
  meaningfully lower than Matomo's** because engaged single-page sessions
  (dwell past the threshold, or any event) no longer count as bounces —
  that's the corrected definition (03), not an accounting error.
- **Average times will read lower too, for the mirror-image reason.** Matomo's
  "visit duration" is a *span* (last action − first action): read 2 min,
  background the tab 20, return for 2 → a "24-minute visit". Our `engaged_ms`
  is *accrued active time* (inter-ping gaps clamped at 20 s), so the same
  visit reads ~4 min. Both metrics get more truthful at cutover; neither delta
  is a regression.
- Bot filtering differs (isbot list vs Matomo's): totals may dip a few
  percent. The diagnostics counter makes the delta visible instead of
  mysterious.
- Realtime becomes push (SSE) instead of Matomo's polling widget.
