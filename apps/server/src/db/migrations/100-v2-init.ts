import type { Migration } from '../migrate.ts';

/**
 * Schema v2 — a clean-slate line starting at version 100 (docs/03).
 *
 * Versions 1–99 belong to featherstat v1; a v1 database is never migrated in
 * place — `featherstat import v1 <path>` rewrites it into a fresh v2 file
 * (migrate.ts refuses the v1 range with exactly that instruction). The v1
 * binary's own newer-than-me guard refuses a v2 file symmetrically.
 *
 * One migration on purpose: v2 has shipped nowhere, so consolidating beats a
 * replay of history nobody has. Once v2 ships, this file freezes and the
 * append-only rule resumes at 101.
 *
 * Denormalized on purpose, as in v1: skipped joins are query latency kept.
 */
export const migration100: Migration = {
  version: 100,
  name: 'v2-init',
  sql: `
-- ---------------------------------------------------------------------------
-- Core (v1 final shape + v2 columns)
-- ---------------------------------------------------------------------------

CREATE TABLE sites (
  id          INTEGER PRIMARY KEY,        -- preserved from Matomo / v1 import
  name        TEXT NOT NULL,
  domains     TEXT NOT NULL,              -- JSON array; first entry is canonical
  timezone    TEXT NOT NULL DEFAULT 'America/New_York',
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER                     -- tombstone: ingest/query ignore; the purge job finishes
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,        -- rowid; low bits of the data-version for ETags
  site_id     INTEGER NOT NULL,
  ts          INTEGER NOT NULL,           -- UTC unix ms
  local_date  TEXT NOT NULL,              -- 'YYYY-MM-DD' in site tz, computed at ingest
  local_hour  INTEGER NOT NULL,           -- 0-23 in site tz
  type        TEXT NOT NULL,              -- 'pageview' | 'event' | 'outlink' | 'download' | 'ping'
  visitor_id  BLOB NOT NULL,              -- 8 bytes, daily-rotating
  session_id  BLOB NOT NULL,              -- 8 random bytes
  seq         INTEGER NOT NULL,           -- 1-based position within its session

  hostname    TEXT, path TEXT, title TEXT,
  target_url  TEXT,                       -- outlink/download destination

  ref_domain  TEXT, ref_type TEXT,        -- 'direct'|'search'|'social'|'referral'|'campaign'|'internal'
  utm_source  TEXT, utm_medium TEXT, utm_campaign TEXT,
  -- Pre-normalization values, stored ONLY when they differ from the
  -- normalized columns above — near-always NULL (docs/03 § Campaigns).
  utm_source_raw TEXT, utm_medium_raw TEXT, utm_campaign_raw TEXT,

  event_category TEXT, event_action TEXT, event_name TEXT, event_value REAL,

  browser     TEXT, browser_version TEXT, os TEXT,
  device_type TEXT,                       -- 'desktop'|'mobile'|'tablet'|'other'
  screen      TEXT, lang TEXT,

  country     TEXT,                       -- ISO 3166-1 alpha-2
  region      TEXT, city TEXT,
  lat REAL, lon REAL,
  scroll_pct  INTEGER,                    -- 0-100; NULL is unmeasured, never 0
  props       TEXT                        -- canonical JSON object, sorted keys; NULL = none
);

CREATE INDEX ix_events_site_ts           ON events (site_id, ts);
CREATE INDEX ix_events_site_date_visitor ON events (site_id, local_date, type, visitor_id);
CREATE INDEX ix_events_session           ON events (session_id);

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
  ref_domain TEXT, ref_type TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  utm_source_raw TEXT, utm_medium_raw TEXT, utm_campaign_raw TEXT,
  browser TEXT, os TEXT, device_type TEXT,
  country TEXT, region TEXT, city TEXT
);

CREATE INDEX ix_sessions_site_date ON sessions (site_id, local_date);
CREATE INDEX ix_sessions_open      ON sessions (site_id, visitor_id, last_seen_at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Bots are dropped at the door and counted, never stored (docs/03 § Bots).
CREATE TABLE bot_drops (
  site_id    INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, local_date)
);

-- ---------------------------------------------------------------------------
-- Auth: admin sessions (v1) + principals (v2 — docs/04 § 5)
-- ---------------------------------------------------------------------------

CREATE TABLE admin_sessions (
  id             TEXT PRIMARY KEY,        -- 32 random bytes, hex
  created_at     INTEGER NOT NULL,        -- UTC unix ms
  expires_at     INTEGER NOT NULL,
  principal_kind TEXT NOT NULL DEFAULT 'admin',  -- 'admin' | 'viewer'
  viewer_id      INTEGER                  -- set iff principal_kind = 'viewer'
);

CREATE INDEX ix_admin_sessions_expiry ON admin_sessions (expires_at);

-- Scoped read-only API tokens. The raw token ("fs_" + base64url) is returned
-- once at mint time and only its sha256 is stored — a leaked DB mints nothing.
CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   BLOB NOT NULL UNIQUE,      -- sha256 of the raw token
  site_scope   TEXT NOT NULL,             -- 'all' or JSON array of site ids
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,                   -- written at most hourly
  revoked_at   INTEGER                    -- NULL while live
);

-- Invited read-only viewers, delivered a magic link out of band (docs/04 § 5).
CREATE TABLE viewers (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  site_scope TEXT NOT NULL,               -- 'all' or JSON array of site ids
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE magic_links (
  token_hash BLOB PRIMARY KEY,            -- sha256 of the raw link token
  viewer_id  INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER                      -- single use
);

-- ---------------------------------------------------------------------------
-- Dashboards & share links (v1 + library columns)
-- ---------------------------------------------------------------------------

CREATE TABLE dashboards (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,              -- denormalized from layout.name for listing
  site_scope  TEXT NOT NULL,              -- 'all' or a site id, from layout.site
  layout      TEXT NOT NULL,              -- Dashboard JSON, DashboardSchema-validated on write
  template    TEXT,                       -- shipped-template id this was cloned from (reset target)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL            -- UTC unix ms
);

CREATE TABLE share_tokens (
  token_hash   BLOB PRIMARY KEY,          -- sha256 of the raw token
  dashboard_id INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,          -- UTC unix ms
  revoked_at   INTEGER                    -- NULL while live
);

CREATE INDEX ix_share_tokens_dashboard ON share_tokens (dashboard_id);

-- ---------------------------------------------------------------------------
-- Query-layer objects: segments, derived metrics, goals (docs/04 § 3)
-- All three store client-authored JSON; the routes zod-validate on every
-- write AND the query layer re-parses on every read.
-- ---------------------------------------------------------------------------

CREATE TABLE segments (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  filter     TEXT NOT NULL,               -- one FilterNode (no segment refs — no cycles)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE derived_metrics (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,        -- ^[a-z][a-z0-9_]{0,31}$, disjoint from MetricSchema
  expr       TEXT NOT NULL,               -- arithmetic over metric names; parsed, never eval'd
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE goals (
  id         INTEGER PRIMARY KEY,
  site_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  filters    TEXT NOT NULL,               -- JSON array of FilterNode
  value_expr TEXT,                        -- 'event_value' | 'fixed:<number>' | NULL
  target     REAL,                        -- optional completions target (display only)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (site_id, name)
);

-- ---------------------------------------------------------------------------
-- Campaign layer (docs/03 § Campaigns)
-- ---------------------------------------------------------------------------

CREATE TABLE campaign_aliases (
  site_id   INTEGER NOT NULL,             -- 0 is reserved for install-wide rows
  field     TEXT NOT NULL CHECK (field IN ('source','medium','campaign')),
  alias     TEXT NOT NULL,                -- matched AFTER lowercase+trim
  canonical TEXT NOT NULL,
  PRIMARY KEY (site_id, field, alias)
);

CREATE TABLE campaigns (
  id               INTEGER PRIMARY KEY,
  site_id          INTEGER NOT NULL,
  name             TEXT NOT NULL,         -- the canonical utm_campaign value
  expected_sources TEXT,                  -- JSON array, NULL = anything
  expected_mediums TEXT,
  starts_at        TEXT,                  -- local dates; NULL = open
  ends_at          TEXT,
  notes            TEXT,
  created_at       INTEGER NOT NULL,
  UNIQUE (site_id, name)
);

-- ---------------------------------------------------------------------------
-- Props governance (docs/03 § Props). Caps live here, not in the rows:
-- the registry tables bound cardinality by construction, and prop_drops is
-- the diagnostics mirror of bot_drops.
-- ---------------------------------------------------------------------------

CREATE TABLE prop_keys (
  site_id         INTEGER NOT NULL,
  key             TEXT NOT NULL,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  events          INTEGER NOT NULL DEFAULT 0,   -- rows carrying this key
  distinct_values INTEGER NOT NULL DEFAULT 0,
  over_cap_since  INTEGER,                -- set when the value-cardinality clamp engaged
  PRIMARY KEY (site_id, key)
);

CREATE TABLE prop_values (
  site_id INTEGER NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (site_id, key, value)
);

CREATE TABLE prop_drops (
  site_id    INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  reason     TEXT NOT NULL,               -- 'too_many_keys'|'oversize'|'bad_key'|'ip_shaped'|'value_clamped'
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, local_date, reason)
);

-- ---------------------------------------------------------------------------
-- Annotations: operator notes pinned to a moment, rendered on timeseries.
-- ---------------------------------------------------------------------------

CREATE TABLE annotations (
  id         INTEGER PRIMARY KEY,
  site_id    INTEGER,                     -- NULL = all sites
  ts         INTEGER NOT NULL,            -- UTC unix ms
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Rollups (docs/03 § Rollups) — maintained in the SAME write transaction as
-- the flush, so within any committed snapshot they can never lag raw rows.
-- Retention prunes raw events/sessions and the presence tables; it never
-- touches rollup rows — rollups outliving raw is the point.
-- ---------------------------------------------------------------------------

-- Additive event metrics, hour grain, no dimension: totals and time series.
CREATE TABLE rollup_traffic_hour (
  site_id         INTEGER NOT NULL,
  local_date      TEXT    NOT NULL,
  local_hour      INTEGER NOT NULL,
  hits            INTEGER NOT NULL DEFAULT 0,   -- every stored row incl. pings
  actions         INTEGER NOT NULL DEFAULT 0,   -- non-ping
  pageviews       INTEGER NOT NULL DEFAULT 0,
  events          INTEGER NOT NULL DEFAULT 0,
  outlinks        INTEGER NOT NULL DEFAULT 0,
  downloads       INTEGER NOT NULL DEFAULT 0,
  event_value_sum REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, local_date, local_hour)
) WITHOUT ROWID;

-- Additive event metrics + exact per-day distincts, day grain, ONE dimension.
-- dim_id is a small integer from rollup/tables.ts, never client input
-- (invariant 9). dim_null=1 encodes SQL NULL (the direct-traffic group);
-- dim_value is '' for that row, and a literal empty string keeps dim_null=0.
-- hits counts EVERY stored row (pings included) so the read path emits exactly
-- the groups a raw query over the events table would — a key only heartbeats
-- touched still gets its (zero-valued) row.
CREATE TABLE rollup_dim_day (
  site_id          INTEGER NOT NULL,
  local_date       TEXT    NOT NULL,
  dim_id           INTEGER NOT NULL,
  dim_value        TEXT    NOT NULL,
  dim_null         INTEGER NOT NULL DEFAULT 0,
  hits             INTEGER NOT NULL DEFAULT 0,   -- every stored row incl. pings
  actions          INTEGER NOT NULL DEFAULT 0,
  pageviews        INTEGER NOT NULL DEFAULT 0,
  events           INTEGER NOT NULL DEFAULT 0,
  outlinks         INTEGER NOT NULL DEFAULT 0,
  downloads        INTEGER NOT NULL DEFAULT 0,
  event_value_sum  REAL    NOT NULL DEFAULT 0,
  visitors         INTEGER NOT NULL DEFAULT 0,  -- exact per-day distinct via rollup_visitor_seen
  sessions_touched INTEGER NOT NULL DEFAULT 0,  -- exact per-day distinct via rollup_session_seen
  PRIMARY KEY (site_id, local_date, dim_id, dim_value, dim_null)
) WITHOUT ROWID;

-- Session metrics, day grain (sessions have no hour), dim_id 0 = no dimension.
-- Every column is an additive numerator/denominator; ratios recompose exactly:
--   bounce_rate = bounced/visits · avg_engagement = engaged_ms/measured_sessions
--   views_per_visit = session_pageviews/visits
CREATE TABLE rollup_sessions_day (
  site_id           INTEGER NOT NULL,
  local_date        TEXT    NOT NULL,     -- the date the session STARTED
  dim_id            INTEGER NOT NULL,
  dim_value         TEXT    NOT NULL,
  dim_null          INTEGER NOT NULL DEFAULT 0,
  visits            INTEGER NOT NULL DEFAULT 0,
  measured_sessions INTEGER NOT NULL DEFAULT 0, -- engaged_ms > 0
  engaged_ms        INTEGER NOT NULL DEFAULT 0, -- over ALL sessions
  bounced           INTEGER NOT NULL DEFAULT 0, -- can be decremented when a session un-bounces
  session_pageviews INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, local_date, dim_id, dim_value, dim_null)
) WITHOUT ROWID;

-- Exact-distinct helpers: one row per (visitor|session, day, rolled group).
-- The daily salt closes a day, so rows older than ingest can reach are dead
-- weight — the write path prunes each site's stale days at day rollover
-- (rollup/apply.ts, PRESENCE_HORIZON_DAYS); the counts above are the survivors.
CREATE TABLE rollup_visitor_seen (
  site_id    INTEGER NOT NULL,
  local_date TEXT    NOT NULL,
  dim_id     INTEGER NOT NULL,
  dim_value  TEXT    NOT NULL,
  dim_null   INTEGER NOT NULL DEFAULT 0,
  visitor_id BLOB    NOT NULL,
  PRIMARY KEY (site_id, local_date, dim_id, dim_value, dim_null, visitor_id)
) WITHOUT ROWID;

CREATE TABLE rollup_session_seen (
  site_id    INTEGER NOT NULL,
  local_date TEXT    NOT NULL,
  dim_id     INTEGER NOT NULL,
  dim_value  TEXT    NOT NULL,
  dim_null   INTEGER NOT NULL DEFAULT 0,
  session_id BLOB    NOT NULL,
  PRIMARY KEY (site_id, local_date, dim_id, dim_value, dim_null, session_id)
) WITHOUT ROWID;

-- engagement_threshold_ms (bounce definition baked into 'bounced' — a config
-- change must force a rebuild), rollup_schema_rev, raw_horizon_ts.
CREATE TABLE rollup_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
};
