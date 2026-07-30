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
CREATE INDEX ix_events_session   ON events (session_id);
-- Covers `visitors` = COUNT(DISTINCT visitor_id) whole: every column of the
-- query is in the index, so the count never touches the table. It replaced the
-- narrower (site_id, local_date, type) — same prefix, same seeks, so keeping
-- both bought no plan and cost every insert a second B-tree.
CREATE INDEX ix_events_site_date_visitor ON events (site_id, local_date, type, visitor_id);

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

- `day_salt` is random, held in the `settings` table under
  `salt:<IANA zone>:<YYYY-MM-DD>`, and rotated at **00:00 site-local** — the
  same boundary `local_date` is computed on. Every strictly older salt for that
  zone is deleted. After rotation, yesterday's hashes are unlinkable to today's
  — this is the Plausible model, and it is why "unique visitors" is exact within
  a day and approximate across longer ranges. Two things carry that consequence
  rather than leaving it to be remembered: the metric declares
  `aggregate: 'distinct'`, so nothing may add its buckets into a range total
  (see § Derived metrics below), and every figure drawn from a distinct measure
  wears the approximation mark — KPI tile and site card alike, from the
  declaration and not from the metric's name (`widgets/ApproxMark.svelte`).

### Why the salt is keyed by timezone, and what that buys

Keyed by **zone**, not by site: `site_id` is already inside the hash, so two
sites sharing a zone can share one salt row without their visitors colliding,
and a single-timezone install keeps exactly one salt per day. A per-site salt
would be one more row per site for no property a query can see.

Aligning the rotation to the boundary the dashboards already bucket on is worth
more than tidiness. A UTC-keyed salt made a visitor id belong to a UTC day while
every row it landed on was stamped with a *local* day, and four things followed:

- **Two screens disagreed.** A range-wide distinct visitor count and the sum of
  its per-local-day counts differed — 1.9 % on the replay corpus. With the
  boundary aligned every id belongs to exactly one `local_date`, so the range
  total **equals** the sum of its day buckets, exactly. That is asserted as
  invariant 10 in `test/replay/invariants.test.ts`, together with the fact that
  the same corpus is *not* additive over UTC days — the equality is the
  alignment, not a corpus in which nobody stays up past midnight.
- **Daily rollups can be exact** for the buckets we display, if they are ever
  needed (§ Size & retention). Under a UTC-keyed salt a rolled-up day could only
  ever approximate its own visitor count.
- **Sessions no longer split mid-evening.** The boundary was 20:00 local for a
  US-Eastern site, inside a day the stats report as one day.
- **Returning-reader revival** (`SESSION_REVIVAL_MS`) is bounded by local
  midnight rather than by an arbitrary hour of the local evening.

Rotation is **forward-only** — `if (date > current)` on the ISO dates
themselves. A backward clock step (NTP) therefore cannot re-mint the current
salt and re-key every visitor mid-day. Timezones are the interesting case:
US transitions are at 02:00, so local midnight always exists there, but some
zones move their clocks *at* midnight. `America/Santiago` skips 00:00–00:59 on
its spring transition — the date still advances, so the salt rotates exactly
once. `America/Havana` repeats the 00:00 hour on its autumn one — the date does
not go backwards (a repeat is not a step back to the previous day), so the
doubled hour keeps one salt and the visitor keeps one id. Both are tested
against the real tz database in `pipeline/identity.test.ts`.

This is **forward-only for history too**: rows already written keep the ids they
were minted with, and nothing re-hashes them. There is therefore one transition
day per install on which both boundaries appear in the data — see
[06](06-migration.md) § Changes made during the bake.
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
  00:00 UTC. That is deliberately not the day salt's boundary (site-local): an
  alias labels a live feed somebody is watching right now, so which day it
  belongs to is a question nobody asks of it. The day input is load-bearing for
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
   session row (attribution + device + geo copied from this first hit) — unless
   the hit is a ping, which never starts a visit (see below).
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

### A ping never starts a visit (session revival)

The heartbeat only fires while the tab is **focused and visible** — deliberately,
so a page parked on a second monitor does not ping forever. A reader who reads
for three minutes, switches away for half an hour and comes back therefore sends
nothing at all in between, and their next hit is a *ping*.

Treating that ping like any other hit opened a brand-new session with no
pageview in it: an extra visit, and a second span of attention credited to no
page at all (`dwell` drops events before a session's first pageview). On
production that was 4.1 % of visits.

A ping is a **continuation signal**, so:

- With no live session it **revives the visitor's most recent one** —
  same `session_id`, same `started_at`, `local_date` and first-touch
  attribution, `seq` carrying on. Reviving is bounded by the
  **returning-reader window** (`SESSION_REVIVAL_MS`, 4 h): long enough to cover
  a lunch break or a meeting, short enough that a machine woken the next
  morning starts a fresh visit rather than resurrecting last night's, and short
  enough that revived engagement lands on the same site-local day in all but a
  sliver of cases.
- The 20 s clamp is untouched, so bridging half an hour of silence credits **one
  heartbeat's worth** of attention, not half an hour. 3 min + 3 min reads as
  ~6 min of engagement on one page, which is what it was.
- With nothing to revive the ping is **dropped**: never stored, never counted.
  A visit whose every row is a heartbeat is a visit nobody made, and its rows
  could not be attributed to a page anyway. Ingest's only other drop is bots.

**Limitation, stated rather than papered over**: `visitor_id` rotates at 00:00
site-local (see Identity), so revival can never cross that boundary — its
effective reach is `min(4 h, time since the site's last local midnight)`. A
reader who steps away at 23:50 and returns at 00:20 is a different visitor by
then, and their heartbeats are dropped rather than joined to the earlier visit.
That is a boundary a visit legitimately ends at, which is the point of moving
it: it used to fall at 20:00 local for a US-Eastern site, mid-evening and inside
a day the stats report as one day. Sites that opt into `uid` hashing get a
stable per-site salt, so revival works across the whole window for them.

A revived visit can stop being a bounce, and that is correct: bounce is
engagement-aware (below), and a focus-gated heartbeat is evidence of attention.
The clamp bounds what one revival can grant to 20 s, so no visit is argued out
of bounce status by idleness alone.

Where revival reads from: **not** a widened open-session map (restart recovery
still loads only the 30-minute window) but a targeted indexed read of one
visitor's latest session — `ix_sessions_open (site_id, visitor_id,
last_seen_at)` — on the rare ping-with-no-live-session path. The live map is
asked first and its answer is final: an entry still held there carries hits the
current batch has not committed, which the store cannot see. For the same reason
the eviction sweep leaves an entry alone until its rows are committed; retention
is unchanged (a committed entry still goes at the idle window), it just cannot be
dropped while the store would then be the only, and stale, account of a visit.

### Populations: which rows a metric counts

A metric's hardest question is not its formula but its **population** — the set
of stored rows it is drawn from. That used to be prose inside a SQL string, and
two metrics quietly disagreed about it: `visitors` excluded heartbeats and
`visits` did not, so under any event-level dimension a group could report a
visit whose visitor it had never counted.

The populations are named once, in `packages/shared` (`measures.ts`), and every
metric declares one instead of writing a row predicate:

| Population | Rows | Read as |
| --- | --- | --- |
| `presence` | every stored hit, heartbeats included | the visitor was here |
| `actions` | every hit that is not a heartbeat | the visitor did something |
| `pageviews` / `events` / `outlinks` / `downloads` | one hit type each | that kind of action |
| `sessions` | every stored visit | a visit |
| `measured_sessions` | visits with `engaged_ms > 0` | a visit the clock could time |
| `measured_pageviews` | page views something followed | a page leg the clock could time |

Naming them does something a shared constant would not: it turns an accidental
difference into a deliberate one. Realtime's "active now" counts **`presence`** —
a reader holding a tab open is here — while the `visitors` KPI counts
**`actions`**, because that reader has not done anything today. Both are right,
they answer different questions, and stated this way a reviewer can check that
the difference was meant. (`isHeartbeat` in `packages/shared` is the single
definition; the compiler, the sequence and dwell kinds, the realtime hub, the
sessionizer and the ntfy notifier all import it rather than spelling `'ping'`.)

Two consequences worth stating:

- **A population compiles to a `CASE`, never a `WHERE`.** One SELECT answers
  metrics of mixed population — `visitors` over `actions` beside `pageviews`
  over its own — so a population that filtered rows would either be wrong or
  force one query per population and a merge in JS.
- **A population can differ by table.** `visits` is a plain count of `sessions`
  rows, and a distinct count over `actions` once an event-level dimension forces
  it onto the events table. The result says which it was (see
  [04](04-api.md) § 3, `measures`).

### Derived metrics

`visits` = sessions — and under an event-level dimension,
where the answer comes from the event rows rather than the session rows, the
distinct sessions **of that group's non-ping rows**, so a group can never hold
a visit whose visitor it did not count; `visitors` = distinct `visitor_id`
**over non-ping rows** (a heartbeat is a continuation signal, not a visit: a
session beating past local midnight must not book its visitor into a day it
never acted in — that reads as `pageviews < visitors`, which is impossible; the
same reasoning is why a ping cannot open a session at all, above);
`engagement time` = `avg_engagement`, which is `engaged_ms` over the
**`measured_sessions`** population (visits with time on the clock) rather than
over all visits — a single-hit visit is unmeasurable, not zero-length, and
dividing by it reports the measurement gap as brevity, the same dishonesty the
time-on-page card refuses. It is a server metric, declaring
`of: {numerator: 'engaged_ms', denominator: 'engaged_sessions'}` so a chart can
re-derive it over a slice instead of averaging averages; the client used to
divide, in two places, with different null semantics. **Time on page** = every event of the session
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
designed so rollups can slot in behind it without any API change — and a
rolled-up day's visitor count would now be *exact* for the day it covers, since
the salt turns over on the same boundary the rollup would key on (§ Identity).
