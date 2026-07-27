import type { Migration } from '../migrate.ts';

/** Schema v1 — docs/03. Denormalized on purpose: skipped joins are query latency kept. */
export const migration001: Migration = {
  version: 1,
  name: 'init',
  sql: `
CREATE TABLE sites (
  id          INTEGER PRIMARY KEY,        -- preserved from Matomo
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
  local_hour  INTEGER NOT NULL,           -- 0-23 in site tz
  type        TEXT NOT NULL,              -- 'pageview' | 'event' | 'outlink' | 'download' | 'ping'
  visitor_id  BLOB NOT NULL,              -- 8 bytes, daily-rotating
  session_id  BLOB NOT NULL,              -- 8 random bytes
  seq         INTEGER NOT NULL,           -- 1-based position within its session

  hostname    TEXT, path TEXT, title TEXT,
  target_url  TEXT,                       -- outlink/download destination

  ref_domain  TEXT, ref_type TEXT,        -- 'direct'|'search'|'social'|'referral'|'campaign'|'internal'
  utm_source  TEXT, utm_medium TEXT, utm_campaign TEXT,

  event_category TEXT, event_action TEXT, event_name TEXT, event_value REAL,

  browser     TEXT, browser_version TEXT, os TEXT,
  device_type TEXT,                       -- 'desktop'|'mobile'|'tablet'|'other'
  screen      TEXT, lang TEXT,

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
  ref_domain TEXT, ref_type TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
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
`,
};
