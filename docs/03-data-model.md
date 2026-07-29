# 03 — Data model

SQLite, WAL mode, one file. Two hot tables (`events`, `sessions`), a handful of
small config tables. Denormalized on purpose: storage is cheap at this scale
and every join we skip is query latency we keep.

## Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE sites (
  id          INTEGER PRIMARY KEY,        -- preserved from Matomo (1–6 today)
  name        TEXT NOT NULL,
  domains     TEXT NOT NULL,              -- JSON array; first entry is canonical
  timezone    TEXT NOT NULL DEFAULT 'America/New_York',
  created_at  INTEGER NOT NULL
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,        -- rowid; also the data-version for ETags
  site_id     INTEGER NOT NULL,
  ts          INTEGER NOT NULL,           -- UTC unix ms
  local_date  TEXT NOT NULL,              -- 'YYYY-MM-DD' in site tz, computed at ingest
  local_hour  INTEGER NOT NULL,           -- 0–23 in site tz
  type        TEXT NOT NULL,              -- 'pageview' | 'event' | 'outlink' | 'download' | 'ping'
  visitor_id  BLOB NOT NULL,              -- 8 bytes, daily-rotating (see Identity)
  session_id  BLOB NOT NULL,              -- 8 random bytes
  seq         INTEGER NOT NULL,           -- 1-based position within its session (journeys)

  -- page / action
  hostname    TEXT, path TEXT, title TEXT,
  target_url  TEXT,                       -- outlink/download destination

  -- attribution (set on the session's first event, denormalized onto each row)
  ref_domain  TEXT, ref_type TEXT,        -- 'direct'|'search'|'social'|'referral'|'campaign'|'internal'
  utm_source  TEXT, utm_medium TEXT, utm_campaign TEXT,

  -- event payload
  event_category TEXT, event_action TEXT, event_name TEXT, event_value REAL,

  -- device (UA-parsed at ingest)
  browser     TEXT, browser_version TEXT, os TEXT,
  device_type TEXT,                       -- 'desktop'|'mobile'|'tablet'|'other'
  screen      TEXT, lang TEXT,

  -- geo (mmdb lookup at ingest; city centroid, never the IP)
  country     TEXT,                       -- ISO 3166-1 alpha-2
  region      TEXT, city TEXT,
  lat REAL, lon REAL
);

CREATE INDEX ix_events_site_ts   ON events (site_id, ts);
CREATE INDEX ix_events_site_date ON events (site_id, local_date, type);
CREATE INDEX ix_events_session   ON events (session_id);

CREATE TABLE sessions (
  id            BLOB PRIMARY KEY,
  site_id       INTEGER NOT NULL,
  visitor_id    BLOB NOT NULL,
  started_at    INTEGER NOT NULL,         -- UTC ms
  last_seen_at  INTEGER NOT NULL,
  local_date    TEXT NOT NULL,
  entry_path    TEXT, exit_path TEXT,
  pageviews     INTEGER NOT NULL DEFAULT 0,
  events        INTEGER NOT NULL DEFAULT 0,
  engaged_ms    INTEGER NOT NULL DEFAULT 0,
  -- first-touch attribution + device + geo, copied from the first event
  ref_domain TEXT, ref_type TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  browser TEXT, os TEXT, device_type TEXT,
  country TEXT, region TEXT, city TEXT
);

CREATE INDEX ix_sessions_site_date ON sessions (site_id, local_date);
CREATE INDEX ix_sessions_open      ON sessions (site_id, visitor_id, last_seen_at);

-- Small tables: dashboards (id, name, site_scope, layout JSON),
-- share_tokens, api_tokens, settings (key/value), schema_migrations.
```

Migrations: sequential SQL files applied at boot, tracked in
`schema_migrations`; `PRAGMA user_version` mirrors the latest.

## Visitor identity (cookieless, R9)

```
visitor_id = first 8 bytes of SHA-256(day_salt ∥ site_id ∥ ip ∥ user_agent)
```

- `day_salt` is random, held in the `settings` table, rotated at 00:00 UTC;
  the previous day's salt is deleted. After rotation, yesterday's hashes are
  unlinkable to today's — this is the Plausible model, and it is why "unique
  visitors" is exact within a day and approximate across ranges (documented in
  the UI as such).
- The IP is consumed by the hash and the GeoIP lookup, then discarded. No
  masked-IP column, no debug switch that quietly stores it.
- Matomo's `_id` parameter (16-hex visitor id), when present, replaces the
  fingerprint input — it makes the shim's behavior identical to Matomo's
  cookieless config mode.
- Sites that want logged-in continuity may send `uid`; it is hashed with a
  *stable* per-site salt instead (opt-in via the `uid_enabled:<site id>`
  settings key, off by default — otherwise `uid` is ignored, so a tag cannot
  defeat the daily rotation unilaterally).

### Realtime visitor aliases (SSE only)

The realtime feed needs to tell several hits from one city apart — one
visitor or several — without ever shipping the visitor id. Each wire hit
therefore carries an **ephemeral alias**:

```
alias = word-lists[ sha256(UTC day ∥ visitor_id) ]   →  {name, color}
```

- `name` is a whimsical alliterating two-word name (`Avaricious Aardvark`)
  drawn from two curated 48-entry lists in `packages/shared`, paired by
  initial letter; `color` is a categorical palette index derived from the
  name. ~96 distinct names: collisions at this fleet's scale (a handful of
  concurrent visitors) are rare and accepted — two colliding visitors simply
  merge in the live view.
- The derivation is one-way and includes the **UTC day**, so aliases reset at
  00:00 UTC exactly like the day salt. The day input is load-bearing for
  `_id`- and `uid`-derived visitor ids, which do not rotate on their own.
- Aliases exist **only on the SSE wire**: never stored, never logged, and the
  line holds — there is **no visitor dimension in the query vocabulary**.
  Nothing can list, filter, or aggregate by visitor; the alias merely lets
  the live feed's reader see that two hits share an origin for one day.

## Sessionization

In-memory map `(site_id, visitor_id) → { session_id, last_seen, … }`, 30 min
idle timeout — the industry-standard visit definition, matching Matomo's.

Per incoming hit:

1. Lookup the open session; if none, or `now − last_seen > 30 min`, create a
   session row (attribution + device + geo copied from this first hit).
2. Update counters, `exit_path`, `last_seen_at`; assign the hit's `seq` from
   the session's running event count.
3. **Engagement**: add `min(now − last_seen, 20 s)` to `engaged_ms`. Heartbeat
   pings (15 s, focus-gated, from the existing tags) make this a faithful
   active-time measure — which is the direct fix for Matomo's
   "time on page is 0 for single-page visits" failure. Pings update the
   session but are excluded from pageview/bounce math.
4. Session updates ride the same 200 ms batch transaction as event inserts.

Restart recovery: on boot, sessions with `last_seen_at` within 30 min are
loaded back into the map. Crash-loss window ≈ one batch interval.

Derived metrics: `visits` = sessions; `visitors` = distinct `visitor_id`
**over non-ping rows** (a heartbeat is a continuation signal, not a visit: a
session beating past local midnight must not book its visitor into a day it
never acted in — that reads as `pageviews < visitors`, which is impossible);
`engagement time` = `engaged_ms`, averaged over `engaged_sessions` (visits with
time on the clock) rather than all visits — a single-hit visit is unmeasurable,
not zero-length, and dividing by it reports the measurement gap as brevity, the
same dishonesty the time-on-page card refuses; **time on page** = every event of the session
— pings included — credits `min(gap to the next event, 20 s)` to the *current*
page, i.e. the most recent pageview at or before it. That is the same clamped
accrual `engaged_ms` uses, attributed per page instead of per session, and it is
computed by window function at query time (no row updates on the append-only
events table). The session's **last** event has no next event, so its gap is
unmeasurable and counts for nothing: a page view that nothing followed is
*excluded* from the average rather than recorded as a zero, and the `dwell`
query reports `views_measured` so a reader knows what the number rests on
(see [04](04-api.md) § 3).

**Bounce is engagement-aware, by design.** A session is a bounce only if it
showed *no* engagement: exactly one pageview, no events, **and**
`engaged_ms` below the engagement threshold (default 15 s, configurable).
Someone who lands on one article and reads it for three minutes is exactly
what a site wants — dwell time (via heartbeat) and events both count as
engagement, so that visit is not a bounce. This deliberately departs from
Matomo's one-pageview definition (which reports every satisfied
single-article reader as a bounce); the reporting delta at cutover is called
out in [06-migration.md](06-migration.md).

## Attribution (referrer classification at ingest)

Priority order, evaluated once per session on its first hit:

1. `utm_*` / `mtm_*` / `pk_*` params present → `campaign` (both param
   families accepted; stored under the `utm_*` columns).
2. Referrer hostname ∈ site's own domains → `internal` (not a referral).
3. Referrer matches a small built-in search/social table (~50 entries — the
   long tail is not worth a database) → `search` / `social`.
4. Any other referrer → `referral`; none → `direct`.

## Journeys (event sequences)

Sessions already carry entry/exit and engaged time; `seq` gives every event
its position within its session, which makes sequence analysis plain SQL — no
extra tables:

- **Transitions** (feeds the journey sankey): self-join `events` on
  `(session_id, seq+1)` → weighted step→step edges (pages *and* events),
  bucketed by distance from entry.
- **Flows** (the top-journeys table): per session, concatenate the first N
  steps into a signature string (window function), then `GROUP BY` signature
  → session count, avg engaged time, exit-vs-continue share.

At target scale these run in milliseconds over the range being viewed. If a
large deployment ever needs more, a flows rollup can hide behind the same
query vocabulary (see 04) without any API change.

## Timezones

`ts` is UTC. `local_date`/`local_hour` are computed **at ingest** from the
site's IANA timezone, so date bucketing, "today", and the hour×weekday heatmap
are cheap indexed lookups with no tz math at query time. If a site's timezone
is ever changed, a one-shot backfill recomputes the two columns.

## Bots

Dropped at the door (`isbot` on the UA), counted per site per day in a
`settings`-adjacent counter surfaced in diagnostics. Storing bot traffic just
to filter it from every query is Matomo-brain; we decline.

## Size & retention

Rough event row cost ≈ 250–350 B including indexes. Current fleet volume
(≈ thousands of events/day across six sites) ⇒ **tens of MB per year**. Default
retention: keep raw events forever.

Escape hatches, deliberately deferred (not in v1): daily rollup tables when a
deployment approaches ~10 M raw events, and age-based pruning of raw rows once
rollups exist. The query engine's vocabulary (metric × dimension × range) is
designed so rollups can slot in behind it without any API change.
