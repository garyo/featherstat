# 10 — The SQLite file is yours: the read contract

The database is one SQLite file, and reading it directly — from a Python
notebook, DuckDB, `sqlite3` on the box — is a supported way to use featherstat,
not a trick that happens to work. This document says exactly what that support
covers: which tables and columns are a contract, how to read a live file
without corrupting your copy, and what we promise about change.

The query API (docs/04 § 3) is still the right front door for most questions —
it knows the metric semantics (engagement-aware bounce, measured-only
averages, distinct-visitor honesty) that raw SQL makes easy to get wrong. This
contract exists for the questions the vocabulary doesn't ask.

## How to read a live file

The server runs WAL mode with a single writer. Two rules follow:

- **Never `cp` a live database.** The file is three files (`analytics.db`,
  `-wal`, `-shm`), and a copy taken mid-checkpoint is silently torn. Take a
  consistent snapshot instead:

  ```sh
  sqlite3 analytics.db "VACUUM INTO 'backup.db'"
  ```

  (or the `.backup` dot-command, which streams pages instead of rewriting
  them). Both are safe against the running server.

- **Open the live file read-only**, so a stray statement from your tool can
  never take the write lock the ingest path needs:

  ```
  file:analytics.db?mode=ro&immutable=0
  ```

  `immutable=0` is spelled out on purpose: `immutable=1` tells SQLite the file
  cannot change and breaks WAL reads of a database that very much does.

## The supported surface

Three data tables plus the version bookkeeping. Column semantics one line
each here; docs/03 is the depth.

### `sites`

| column | meaning |
| --- | --- |
| `id` | site id, stable across import (the query API's `site`) |
| `name` | display name |
| `domains` | JSON array of hostnames; the first entry is canonical |
| `timezone` | IANA zone every `local_date`/`local_hour` below was computed in |
| `created_at` | UTC unix ms |
| `deleted_at` | tombstone; non-NULL rows are logically gone while the purge job finishes |

### `events`

One row per stored hit — pageviews, custom events, outlinks, downloads, and
`ping` heartbeats. Filter `type != 'ping'` for "things a visitor did"
(docs/03 § Populations).

| column | meaning |
| --- | --- |
| `id` | rowid, monotonic; the low bits of the ETag data-version |
| `site_id` · `ts` | site, UTC unix ms |
| `local_date` · `local_hour` | `'YYYY-MM-DD'` / 0–23 in the site's zone, computed at ingest — calendar queries are string comparisons, no tz math needed |
| `type` | `'pageview' \| 'event' \| 'outlink' \| 'download' \| 'ping'` |
| `visitor_id` | 8 bytes, rotates at site-local midnight (docs/03 § Visitor identity) — never sum distincts across days |
| `session_id` · `seq` | visit id and this row's 1-based position in it |
| `hostname` · `path` · `title` | the page; `target_url` the outlink/download destination |
| `ref_domain` · `ref_type` | referrer, canonicalized to eTLD+1 and classified (`'direct'\|'search'\|'social'\|'referral'\|'campaign'\|'internal'`); `ref_domain_raw` holds the received host ONLY when canonicalization changed it (docs/03 § Attribution) |
| `utm_source/medium/campaign` | normalized (docs/03 § Campaigns); `*_raw` twins hold the pre-normalization value ONLY when it differed — near-always NULL |
| `event_category/action/name/value` | the custom-event payload |
| `browser` · `browser_version` · `os` · `device_type` · `screen` · `lang` | UA-parsed at ingest |
| `country` · `region` · `city` · `lat` · `lon` | GeoIP city centroid — never an address; no IP is stored anywhere in this file |
| `scroll_pct` | 0–100 high-water mark; NULL is unmeasured, never 0 |
| `props` | canonical JSON object (sorted keys) or NULL; read with `json_extract` (docs/03 § Props) |

### `sessions`

One row per visit, sessionized at ingest (docs/03 § Sessionization).
Attribution and device columns are the visit's first event, denormalized.

| column | meaning |
| --- | --- |
| `id` · `site_id` · `visitor_id` | visit id, site, the (daily-rotating) visitor |
| `started_at` · `last_seen_at` | UTC ms; a session is *dated* by where it started |
| `local_date` | the start's site-local date |
| `entry_path` · `exit_path` | first and last page |
| `pageviews` · `events` | counters over the visit |
| `engaged_ms` | accrued engaged time; 0 on a single-hit visit means *unmeasured*, not zero seconds |
| `ref_*` · `utm_*` (+ `_raw`) · `browser` · `os` · `device_type` · `country` · `region` · `city` | as on `events`, from the first event |

### Versioning

`schema_migrations` (`version`, `name`, `applied_at`) lists every applied
migration, and `PRAGMA user_version` mirrors the highest one. Check it first:
a script that asserts `user_version >= 100` (the v2 line) fails loudly on a
file it doesn't understand instead of misreading it.

## What is deliberately NOT in the contract

Everything else in the file is internal, and reading it means reading
implementation:

- **`settings`** — key/value internals, including secrets (salt material, the
  auth secret, password hash).
- **Auth tables** — `admin_sessions`, `api_tokens`, `viewers`, `magic_links`,
  `share_tokens`, `users`, `user_sites`. Hashes at rest, but still not yours
  to read or replicate. (Site *ownership* lives in `user_sites`, deliberately
  a join table here rather than a column on the contracted `sites`.)
- **`dashboards`** — the row exists, but the `layout` JSON's internals are the
  SPA's schema and move with it.
- **Rollup tables** (`rollup_*`) — derived data, rebuildable from raw at any
  time; their shape serves the planner, not you. Query raw rows instead.
- **Props governance** (`prop_keys`, `prop_values`, `prop_drops`) and the
  campaign registry/alias tables — ingest bookkeeping.
- **`bot_drops`** and **`excluded_drops`** — diagnostics counters (hits refused
  as crawler traffic, and hits refused by an exclusion rule).

## The change promise

- **Additive changes are non-breaking and need no announcement**: a new
  column, a new table, a new index may appear in any release. Write your
  queries with named columns, never `SELECT *` positions.
- **Renaming or removing anything in the supported surface is a breaking
  change**: it gets a major version and a migration note that names the old
  and new spelling. Between those, what this document lists is stable.
- `user_version` moves with every schema migration, additive ones included —
  it says "the file changed", not "your query broke". The table above is what
  says that.
