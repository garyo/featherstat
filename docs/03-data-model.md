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
  ref_domain_raw TEXT,                    -- received host, ONLY when canonicalization changed it
  utm_source  TEXT, utm_medium TEXT, utm_campaign TEXT,
  -- as received, ONLY when normalization changed it (§ Campaigns) — near-always NULL
  utm_source_raw TEXT, utm_medium_raw TEXT, utm_campaign_raw TEXT,

  -- event payload
  event_category TEXT, event_action TEXT, event_name TEXT, event_value REAL,

  -- device (UA-parsed at ingest)
  browser     TEXT, browser_version TEXT, os TEXT,
  device_type TEXT,                       -- 'desktop'|'mobile'|'tablet'|'other'
  screen      TEXT, lang TEXT,

  -- geo (mmdb lookup at ingest; city centroid, never the IP)
  country     TEXT,                       -- ISO 3166-1 alpha-2
  region      TEXT,                       -- the source's own word: DB-IP City
                                          --   Lite gives a NAME ("Massachusetts"),
                                          --   the Matomo importer a code ("MA");
                                          --   the dashboard codes US/CA for display
  city        TEXT,
  lat REAL, lon REAL,
  scroll_pct  INTEGER,                    -- 0-100, native tracker only (v5).
                                          --   NULL is UNMEASURED, never 0: the
                                          --   shim, the importer and every row
                                          --   before v5 have no reading.
  props       TEXT                        -- custom props (§ Props): canonical
                                          --   JSON, sorted keys, no whitespace;
                                          --   NULL = no bag ('{}' never stored)
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
  local_date    TEXT NOT NULL,            -- the date the visit STARTED, in site tz
  local_hour    INTEGER,                  -- 0–23, the hour it started (schema 104)
  entry_path    TEXT, exit_path TEXT,
  pageviews     INTEGER NOT NULL DEFAULT 0,
  events        INTEGER NOT NULL DEFAULT 0,
  engaged_ms    INTEGER NOT NULL DEFAULT 0,
  -- first-touch attribution + device + geo, copied from the first event
  ref_domain TEXT, ref_type TEXT, ref_domain_raw TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  utm_source_raw TEXT, utm_medium_raw TEXT, utm_campaign_raw TEXT,  -- first-touch, like the columns above
  browser TEXT, os TEXT, device_type TEXT,
  country TEXT, region TEXT, city TEXT
);

CREATE INDEX ix_sessions_site_date ON sessions (site_id, local_date);
CREATE INDEX ix_sessions_open      ON sessions (site_id, visitor_id, last_seen_at);

-- Small tables: dashboards (id, name, site_scope, layout JSON), share_tokens,
-- api_tokens, viewers, magic_links, admin_sessions, users, user_sites
-- (site ownership, docs/04 § 5), settings (key/value), schema_migrations.
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

## Page identity (`path`)

`path` is `pathname + query`: the query string is part of page identity
(`?page=2` and `?q=owls` are different pages), the fragment never is — **and
tracking identifiers are not either**. A click id names the visit, not the
page, and leaving it in `path` fragments every per-page number (top pages,
dwell, journeys, adjacency) one click at a time. So ingest strips a **closed,
documented list** from the query (`pipeline/page-url.ts`, shared with the
v1 importer) and keeps everything else, survivors in their original order:

- the campaign families attribution already reads: `utm_*`, `mtm_*`, `pk_*`;
- click ids that also name their platform (see Attribution below): `fbclid`,
  `gclid`, `gbraid`, `wbraid`, `dclid`, `msclkid`, `twclid`, `ttclid`,
  `li_fat_id`, `igshid`, `igsh`;
- identity/mail-merge ids that name nothing: `mc_eid`, `mc_cid`, `yclid`,
  `_hsenc`, `_hsmi`, `mkt_tok`, `oly_enc_id`, `oly_anon_id`, `vero_id`,
  `s_kwcid`.

A query emptied by stripping collapses to the plain pathname (no trailing
`?`). The raw URL still feeds campaign extraction *before* stripping, so
nothing here loses attribution signal — it moves it where it belongs.

## Attribution (referrer classification at ingest)

Priority order, evaluated once per session on its first hit:

1. `utm_*` / `mtm_*` / `pk_*` params present → `campaign` (both param
   families accepted; stored under the `utm_*` columns).
2. No campaign params but a platform click id (see Page identity) →
   `campaign`, with **synthesized** `utm_source`/`utm_medium` — derived, not
   received; industry-standard but inferred, the way Matomo/GA treat `gclid`:
   `gclid|gbraid|wbraid|dclid` → google/cpc, `fbclid` → facebook/social,
   `msclkid` → bing/cpc, `twclid` → twitter/social, `ttclid` → tiktok/social,
   `li_fat_id` → linkedin/social, `igshid|igsh` → instagram/social. This is
   why `fbclid` from Facebook's in-app browser (which sends no referrer) no
   longer reads as direct traffic. The click id outranks a referrer too — it
   is the more specific signal — and the referrer domain is still kept in
   `ref_domain`. Values pass through the campaign normalizer (§ Campaigns) so
   aliases apply; `utm_campaign` is never invented and the `utm_*_raw`
   columns stay NULL (nothing was normalized away). Real campaign params
   always win over a click id.
3. Referrer hostname ∈ site's own domains → `internal` (not a referral).
4. Referrer matches a small built-in search/social table (~50 entries — the
   long tail is not worth a database) → `search` / `social`.
5. Any other referrer → `referral`; none → `direct`.

### Referrer canonicalization

`ref_domain` stores the **canonical** domain, not the received hostname
(`pipeline/referrers.ts`, shared with the importer). Without it `go.bsky.app`
and `bsky.app` are two rows in the Referrers report, and the reader has to add
them up in their head.

1. **Collapse to eTLD+1**: the registrable domain under the Public Suffix
   List, via `tldts` (MIT, bundles the list). One rule fixes `go.bsky.app`,
   `m.facebook.com`, `ca.search.yahoo.com` and `old./out.reddit.com`, and it
   subsumes stripping `www.`. ICANN suffixes only — with the PSL's *private*
   section on, hosts like `vercel.app` are themselves suffixes and would
   canonicalize to nothing.
2. **Keep-distinct exemptions**: hosts where the subdomain is a genuinely
   different source — `news.google.com` is not Google Search,
   `news.ycombinator.com` is not Y Combinator. A short list, each entry
   earning its place.
3. **Aliases**: distinct registrable domains that mean one source, which
   eTLD+1 cannot reach — `t.co` → `twitter.com`, `fb.me` → `facebook.com`,
   `youtu.be` → `youtube.com` — plus the reverse-DNS package ids an
   `android-app://` referrer arrives as (`com.slack` → `slack.com`,
   `com.google.android.gm` → `gmail.com`, where eTLD+1 would answer
   `android.gm`). Two dozen entries, hand-written: MIT forbids taking
   Matomo's lists (GPL-3) or Plausible's (AGPL); Snowplow's `referer-parser`
   (Apache-2.0) is compatible and was inspiration only.
4. **Preserve the original**: the received host lands in `ref_domain_raw`
   **only when it differs** from what was stored.

Classification (steps 4–5 above) reads the canonical domain, so an alias
reaches its search/social entry and a keep-distinct host still finds its
parent's (`news.google.com` stays its own row and still reads as `search`).
Own-domain matching reads the **received** host instead: a site registered as
`docs.example.com` must recognize its own pages, whose eTLD+1 is not the
registered domain.

**Assistants classify as `search`.** ChatGPT, Claude, Perplexity, Copilot and
Gemini are people who asked a question and arrived at an answer, which is what
the search channel means; `ref_domain` still tells them apart from Google. They
are deliberately NOT a new `ref_type` — that enum is stored on every row and
read by the rollups, so a new member is a migration and a rewrite, for a
distinction the domain already carries.

**Editing the tables relabels history, with no migration.** The three tables
are code, so there is no alias-edit endpoint to re-arm the backfill the way
`campaign_aliases` has. Instead the job fingerprints them
(`referrerTablesFingerprint`) and compares it to the value its last *completed*
run recorded; a difference re-arms both watermarks at the next boot. Adding a
host is therefore a one-line change that repairs the past as well as the
future — the property the campaign aliases already have, and the one that makes
these tables safe to grow.

**Canonicalization rewrites history.** Migration 101 adds `ref_domain_raw`
and enqueues `jobs/referrer-backfill.ts` — the campaign-backfill shape:
a settings watermark per table, 5 000-row write transactions sharing the lock
with ingest, resumed at boot after a crash. Each row is re-derived from
**`COALESCE(ref_domain_raw, ref_domain)`** through the same function ingest
runs, which is what makes it idempotent under any sequence of runs or edits to
the tables above. `ref_type` follows the new host on rows carrying a
host-derived type (`search` / `social` / `referral`), so an alias that reaches
a search/social entry reclassifies its history too; `campaign` and `internal`
rows keep their type, because those come from the landing URL and the site's
own domains and neither is on the row. A completed backfill that changed any
row **rebuilds all rollups** (`ref_domain` and `ref_type` are both rolled
dimensions) and **bumps the data epoch** so every pre-rewrite ETag expires.

## Campaigns

The `utm_*` columns store **normalized** values, computed at ingest
(`pipeline/campaigns.ts`, shared with the importer):

1. **Canonicalize**: trim, collapse internal whitespace to single spaces,
   lowercase (`canonicalUtmValue` in `packages/shared`). `EMail` and
   ` email ` are one source; nothing downstream ever case-folds again.
2. **Alias**: look the canonical value up in `campaign_aliases` — the site's
   own row first, then the install-wide row (`site_id = 0`). Aliases let the
   operator declare that `fb`, `facebook.com` and `facebook` are one source
   without touching the tracker. The alias table is read-only at ingest and
   cached whole in memory (`AliasCache`); the admin routes invalidate the
   cache after every write.
3. **Preserve the original**: the as-received value lands in `utm_*_raw`
   **only when it differs** from what was stored — near-always NULL, so the
   columns cost nothing.

Rollups roll the normalized columns, so aliasing at ingest is what keeps the
utm marginals honest with zero query-time work.

**Editing aliases rewrites history.** A `PUT /api/admin/campaign-aliases`
enqueues a chunked, watermarked backfill (`jobs/campaign-backfill.ts`, the
prop-scrub shape: settings watermark per table, 5 000-row write transactions
sharing the lock with ingest, resumed at boot after a crash). Each row's utm
state is re-derived from **`COALESCE(utm_*_raw, utm_*)`** through the same
canonicalize-then-alias pipeline — re-reading from that base is what makes
the job idempotent under any sequence of alias edits, and removing an alias
restores the canonicalized original (raw is NULLed when the two agree
again). A completed backfill that changed any row **rebuilds all rollups**
(the utm marginals moved; per-day recompute, chunked and yielding — minutes
on a large file, the stated cost of an alias edit) and **bumps the data
epoch** so every pre-rewrite ETag expires.

**The campaigns registry** (`campaigns` table: canonical `utm_campaign`
name, optional expected sources/mediums, optional local-date lifespan,
notes) powers the hygiene dimension **`campaign_status`** — `registered`
when a registry row of the row's site names its campaign and the lifespan
covers its local date, `unregistered` otherwise, `untagged` when there is no
campaign at all. It is compiled as a CASE + EXISTS **at query time**, so a
registry edit re-labels all of history instantly: no stored column, no
backfill, and therefore raw-only in the planner (never rolled).

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

**Consecutive identical labels are one step**, in both kinds, applied before the
window function assigns positions. A journey is movement *between* pages, so
`/app → /app → /app` is one step — whether the repeat came from a reload, an
outlink taken from the page it labels, or an SPA router announcing one
navigation twice (04 § 1 stops new ones at the tracker; history still holds the
old ones). A visit whose every row is the same page therefore has one step and
no edges.

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

## Exclusions

The operator's own browsing is the loudest noise on a low-traffic site — on this
project's own deployment, the operator's city was the largest single city on four
of six sites. So a configured address is refused the same way a crawler is:
dropped at the door, counted per site per day in `excluded_drops`, never stored.

A rule is a literal address, a CIDR prefix, or a **hostname**. The hostname form
is the answer for a dynamic residential address: names are re-resolved on a timer
(`pipeline/exclusions.ts`, five minutes) into an in-memory address set, and the
hot path only ever compares bytes against that set — ingest never resolves DNS.
A failed lookup keeps the last known addresses rather than falling open, because
a DNS blip must not quietly re-admit the traffic the operator asked to drop; the
error rides the settings view instead. Each lookup is bounded
(`RESOLVE_TIMEOUT_MS`): a resolver that cannot reach the server it was told to
ask does not fail fast, it hangs, and the admin write awaits this refresh.

**The resolver that matters is the server's, not yours.** A name that resolves
perfectly from a laptop can be unresolvable from the container — the reference
deployment hit exactly this, with a Tailscale split-DNS route sending
`home.example.com` to a home router the server cannot reach, while every
sibling name in the same zone answered in milliseconds. The settings view
reports what the server got, which is the only view that decides anything.

Addresses normalize to the 16-byte IPv6 form (an IPv4 address becomes its
IPv4-mapped equivalent), so one comparison serves both families and a v4 rule
still matches the `::ffff:a.b.c.d` a dual-stack socket reports.

The check runs **before** the bot filter — it is cheaper than a UA parse and
skips the geo lookup outright — so a hit that is both excluded and a crawler
counts as excluded, which is the more useful thing to have been told.

**This does not touch invariant 3.** The rules are the operator's own addresses,
typed by hand: configuration, not observation. No visitor address is stored by
any of it, and the raw IP is still consumed in memory and discarded.

Exclusion applies to hits as they arrive. History already recorded stays — a
retroactive removal is a purge, and per invariant 10 would owe a `data_epoch`
bump like every other history rewrite.

## Rollups

Pre-aggregated tables maintained **in the same write transaction as the ingest
flush** (`rollup/apply.ts`, called by the batcher inside `withWriteTransaction`
— invariant 2 untouched), so within any committed snapshot they can never lag
the raw rows, and a failed flush rolls both back together. Because they are
maintained from the first flush (and the importer rebuilds them per day),
rollups cover ALL history by construction — the read path never needs a
coverage check, only the routing rules below.

The tables (see `db/migrations/100-v2-init.ts`, the authoritative DDL):

- `rollup_traffic_hour` — undimensioned hour grain: `hits` (every stored row,
  pings included), `actions` (non-ping), per-type counts, `event_value_sum`.
- `rollup_dim_day` — day grain × ONE dimension, EAV over the closed
  `ROLLUP_DIMS` table (`rollup/tables.ts`). `dim_id` is a small integer
  **frozen forever** (rollups outlive raw rows, so renumbering merges
  history); `dim_id 0` is the undimensioned row; SQL NULL rolls into
  `(dim_value = '', dim_null = 1)`. `hits` counts EVERY stored row (pings
  included) so the read path emits exactly the groups a raw `GROUP BY` over
  the events table would — a key only heartbeats touched still gets its
  zero-valued row; the metrics are additive event counts over non-ping rows,
  plus `visitors` / `sessions_touched` — **exact** per-day distincts. The key
  leads with `(site_id, local_date)` for the write path; the `dim_id 0` totals
  every KPI tile and time series reads also sit in a partial covering index
  (`ix_…_total`, both EAV tables), so those reads never walk the other
  dimensions' rows. Per-dimension reads stay on the key: an index serving them
  must carry the counters every flush rewrites (migration 105 has the numbers).
- `rollup_sessions_day` — day grain × session-capable dimension, keyed by the
  date the session **started**. Every column is an additive numerator or
  denominator (`visits`, `measured_sessions`, `engaged_ms`, `bounced`,
  `session_pageviews`), so bounce rate, average engagement and views/visit
  recompose exactly.
- `rollup_visitor_seen` / `rollup_session_seen` — presence tables:
  `INSERT OR IGNORE`, and `changes === 1` increments the matching distinct
  count. Exact, never HLL (an estimate would break the equivalence ratchet).
  The daily salt closes each day, so the write path prunes a site's rows past
  `PRESENCE_HORIZON_DAYS` at day rollover; a rebuild repopulates them only
  within that horizon and takes older days' distincts straight from raw
  `COUNT(DISTINCT …)`.
- `rollup_meta` — `engagement_threshold_ms` above all: the bounce definition is
  **baked into `bounced`**, so if the constant changes, session rollups refuse
  to apply (loud log + `needs_rebuild` flag) until a full rebuild re-derives
  history under the new definition. Event rollups are threshold-free and
  continue.

`ROLLUP_DIMS` is exhaustive over the dimension vocabulary, so adding a
dimension forces a decision: rolled (with a frozen `dimId` and which side —
events, sessions, or both, exactly mirroring which tables carry the column in
the compiler's `DIMS`), `derived` (answerable from a rollup row's own keys:
`site`, `local_hour`, `weekday`), or `raw-only` (`title`).

Maintenance discipline:

- **Event side is insert-only and order-free**: the flush pre-groups its rows
  in JS and lands one upsert per touched key; the distinct bookkeeping is a
  FIXED (rolled dims + 1) `INSERT OR IGNORE … SELECT … RETURNING` statements
  per presence table, ranging over the flush's own rowid interval — never one
  statement per event per dimension.
- **Session side is mutation deltas.** The sessionizer mutates one live row
  per open session, so the batcher keeps a per-row snapshot of the mutable
  fields **as last committed** and the flush applies before/after deltas —
  `bounced` can go −1 when a session un-bounces, and `exit_path` (the one
  rolled dimension that mutates) moves its contribution between keys.
  Snapshots advance **only after the transaction commits**, sharing the
  batcher's retry semantics: a failed flush recomputes the same deltas.
  Restart recovery and session revival seed the snapshot from the row just
  read back from the store, or the next flush would book a second visit.
- **Distinct honesty**: per-day distincts are exact; nothing may sum them into
  a range total (uid/`_id`-derived ids are stable across days).
- **Repair = per-day delete + recompute** (`rollup/rebuild.ts`), one write
  transaction per (site, day) with event-loop yields between days. The same
  recompute SELECTs are the equivalence oracle: `rollup/verify.ts` diffs them
  against the stored rows, and `test/replay/rollup-equivalence.test.ts` holds
  flush-incremental == rebuild-from-raw over the whole replay corpus — a
  permanent ratchet (invariant 6).
- **Nightly reconcile** (`jobs/reconcile.ts`): recompute yesterday (site-local)
  from raw per site, repair any drifted day with `rebuildRollupDay`, log it
  loudly and count it in `/metrics` (`analytics_rollup_repairs_total`). The
  flush path is proven equivalent by the ratchet, so production drift is a
  delta-logic bug being reported, not maintenance being done.

The READ path (`query/planner.ts` + `query/rollup-compiler.ts`, wired in the
executor per query): the planner routes a metric query to rollups only when
they can answer EXACTLY what raw would — same rows, same `measures` header —
and to raw the moment anything is in doubt (fail-safe: unknown dimensions,
new ops and rolling windows are slow before they are ever wrong). The rules:

- Metric-kind queries only (journeys/dwell/adjacency/distribution always walk
  raw rows); every referenced dimension (`dim`, `dim2`, filters) rolled or
  derivable from rollup keys (`site`, `weekday`, `local_hour`, the bucket);
  grouping + filters together touch at most ONE rolled dimension — rollups
  store marginals, not joints. So `local_hour × weekday` (the overview
  heatmap) and `path × site` roll up; `path × country` does not. Filtering
  the same dimension a query groups by is fine (still marginal).
- Hour shapes (`bucket: 'hour'` or `local_hour` as either dimension) answer from
  `rollup_traffic_hour`, which has no dim rows, no distincts and no session
  columns: additive event metrics only, no rolled dimension in play. A SESSION
  metric by hour is answerable — sessions carry `local_hour`, the hour the
  visit started — but only from raw, since no stored table holds it.
- **Distinct honesty enforced at routing**: `visitors` (and the events-side
  `visits`) roll up only at day buckets or over a single-day window, and only
  where no filter can merge two dim rows into one group. Everything wider goes
  to raw forever — uid-stable ids make Σ(per-day distinct) structurally wrong,
  and the read-equivalence suite carries a uid-stable visitor spanning days to
  prove the wrong route yields the wrong number.
- Session metrics route to `rollup_sessions_day` unless `rollup_meta` says the
  stored `bounced` is stale — `needs_rebuild`, or an `engagement_threshold_ms`
  other than the code's (the read path checks it itself: the flush path only
  notices a changed threshold on its first apply after boot) — then they fall
  back to raw until the rebuild runs, so bounce numbers are never quietly
  wrong. The threshold also joins the batch ETag, so answers cached under the
  old definition expire on the deploy that changes it.
- The rolling `24h` preset always goes to raw: its edges cut inside local
  dates, and mapping instants onto rollup keys is DST-fraught. Correctness
  first; the shape is cheap on raw.

`test/replay/rollup-read-equivalence.test.ts` is the read ratchet: a
machine-generated metric × dimension × bucket × filter matrix over the replay
corpus, executing every rollup-routed shape against BOTH stores and requiring
identical rows and a byte-identical `measures` header.

## Props

Custom event properties: a small `{key: value}` bag any native-tracker hit
except a ping may carry (`track(action, {props})` / `page(url, title, props)`),
stored on the event row as **canonical JSON** — sorted keys, no whitespace —
in `events.props` (`NULL` = no bag; an emptied bag is never stored as `{}`).
Values are strings (≤ 200 chars), finite numbers or booleans. **The Matomo
shim never produces props, permanently** (docs/04 § 1): the shim exists to
reproduce Matomo's wire behavior during a bake, and Matomo has no such field.

**Caps, enforced at ingest** (`pipeline/props.ts`, constants in
`packages/shared`): key charset `[a-z0-9_-]{1,32}` · 10 props/event (extras
dropped in sorted key order) · 1 KiB canonical JSON per bag (past it the bag
drops whole) · **30 keys per site** (new keys past it drop) · **500 distinct
values per key** — a new value past that is stored as the `"(other)"`
sentinel and `prop_keys.over_cap_since` records when the clamp engaged. Every
breach clamps silently and counts in `prop_drops` (reasons: `bad_key`,
`oversize`, `ip_shaped`, `too_many_keys`, `value_clamped`, `on_ping`) —
a beacon never bounces (invariant 4).

**Governance tables** — `prop_keys` (per-site key stats: first/last seen,
events, distinct values, over-cap timestamp), `prop_values` (the distinct
values, JSON-encoded so `true` and `"true"` stay distinct), `prop_drops` (the
diagnostics mirror of `bot_drops`). The in-memory `PropRegistry` loads a
site's state lazily and runs ahead of the store between flushes; its durable
deltas land **in the same flush transaction as the events they describe**
(invariant 2), so a failed flush retries both together. A crash loses at most
the between-flush in-memory deltas — the tables are the truth a restart
reloads.

**Query surface**: `prop:<key>` is an event-only dimension compiling to
`json_extract(events.props, ?)` with the path **bound**, never in the SQL
text (invariant 9); session metrics under it earn the standing `unsupported`
refusal, and the planner routes every prop shape to raw — prop dims are never
rolled up. Note SQLite's JSON semantics show through in groups: a boolean
prop groups as `1`/`0`. Props stay **off the realtime SSE wire** entirely.

**Privacy posture**: props are operator-owned data and sit OUTSIDE the
cookieless-identity guarantee — nothing stops a determined operator putting
an identifier in a bag. The mitigations are caps (cardinality bounds make
per-visitor identifiers self-defeating), an IP-shape scrub on values
(invariant 3 posture), keeping bags off the SSE wire, and the admin surface
(`GET /api/admin/props`, `DELETE /api/admin/props/:site/:key` → registry
delete + chunked `json_remove` scrub + data-epoch bump). The residual risk —
an operator storing, say, an email per event — is theirs, is visible in the
governance tables, and is erasable with the delete-key scrub.

## Size & retention

Rough event row cost ≈ 250–350 B including indexes. Current fleet volume
(≈ thousands of events/day across six sites) ⇒ **tens of MB per year**. Default
retention: keep raw events forever.

Age-based pruning of raw rows is safe now that the rollup read path is live
(§ Rollups): rollups are never pruned — outliving raw is their point — and the
retention job records the raw floor in `rollup_meta.raw_horizon_ts` before it
deletes anything. Below that floor, rollup-answerable queries keep answering;
a question only raw rows can answer (a raw-only dimension, a joint of two
rolled dimensions, joint filters, a cross-day distinct, session-scoped filters, the sequence kinds)
returns an honest per-query `unsupported` error instead of partial numbers.
The same run ages the prop registry: keys (with their values) last seen before
the horizon and `prop_drops` counters older than it describe rows the prune is
deleting, so they go too.
The query engine's vocabulary (metric × dimension × range) is designed so
rollups slot in behind it without any API change — and a rolled-up day's
visitor count is *exact* for the day it covers, since the salt turns over on
the same boundary the rollup keys on (§ Identity).
