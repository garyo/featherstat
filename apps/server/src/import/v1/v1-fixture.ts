import BetterSqlite3 from 'better-sqlite3';
import type { Db } from '../../db/index.ts';

/**
 * A miniature featherstat v1 database, generated in-test rather than checked
 * in as a binary — deterministic, diffable, and impossible to bit-rot silently.
 *
 * The DDL below is the five v1 migrations VERBATIM from git history (commit
 * 3288b69's parent, files apps/server/src/db/migrations/001-init.ts through
 * 005-scroll-pct.ts). v1 shipped and froze at user_version 5; never edit these
 * strings — they are the record of what a real v1 file looks like, which is
 * the only thing the importer can be tested against.
 */

const V1_MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
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

CREATE TABLE bot_drops (
  site_id    INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, local_date)
);
`,
  },
  {
    version: 2,
    name: 'admin-sessions',
    sql: `
CREATE TABLE admin_sessions (
  id          TEXT PRIMARY KEY,           -- 32 random bytes, hex
  created_at  INTEGER NOT NULL,           -- UTC unix ms
  expires_at  INTEGER NOT NULL
);

CREATE INDEX ix_admin_sessions_expiry ON admin_sessions (expires_at);
`,
  },
  {
    version: 3,
    name: 'dashboards',
    sql: `
CREATE TABLE dashboards (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,              -- denormalized from layout.name for listing
  site_scope  TEXT NOT NULL,              -- 'all' or a site id, from layout.site
  layout      TEXT NOT NULL,              -- Dashboard JSON, DashboardSchema-validated on write
  updated_at  INTEGER NOT NULL            -- UTC unix ms
);

CREATE TABLE share_tokens (
  token_hash   BLOB PRIMARY KEY,          -- sha256 of the raw token
  dashboard_id INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,          -- UTC unix ms
  revoked_at   INTEGER                    -- NULL while live
);

CREATE INDEX ix_share_tokens_dashboard ON share_tokens (dashboard_id);
`,
  },
  {
    version: 4,
    name: 'visitor-covering-index',
    sql: `
CREATE INDEX ix_events_site_date_visitor ON events (site_id, local_date, type, visitor_id);
DROP INDEX ix_events_site_date;
`,
  },
  {
    version: 5,
    name: 'scroll-pct',
    sql: `
ALTER TABLE events ADD COLUMN scroll_pct INTEGER;
`,
  },
];

/** An 8-byte id that reads unmistakably in hex dumps: byte `n`, eight times. */
function bin(n: number): Uint8Array {
  return new Uint8Array(8).fill(n);
}

/** An empty v1 database at `user_version` 5, exactly as a live v1 left it. */
export function createV1Db(path = ':memory:'): Db {
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`);
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of V1_MIGRATIONS) {
    db.exec(m.sql);
    record.run(m.version, m.name, 1_750_000_000_000 + m.version);
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
  return db;
}

/** What `seedV1Fixture` writes — the numbers the importer tests assert against. */
export const V1_FIXTURE = {
  sites: 2,
  events: 12,
  sessions: 6,
  botDropDays: 2,
  dashboards: 2,
  shareTokens: 1,
  adminSessions: 1,
  days: ['2026-07-01', '2026-07-02'] as const,
  /** Session 12's fbclid: one event path + the session's entry and exit. */
  pathsCleaned: 3,
  /** Session 12's event row and session row, both utm-less with a click id. */
  attributionsSynthesized: 2,
  /** Allowlisted settings the importer must carry over, with their values. */
  settings: {
    'salt:America/New_York:2026-07-02': 'aabbccdd00112233',
    'salt:UTC:2026-07-02': '99887766aabbccdd',
    'uidsalt:1': 'feedfacecafebeef',
    'uid_enabled:1': '1',
    ntfy_url: 'https://ntfy.example.com',
    ntfy_topic: 'featherstat-fixture',
    ntfy_token: 'tk_fixture',
    ntfy_rules: '[]',
    retention_days: '400',
  },
  /** Settings the allowlist must skip, reported by name. */
  skippedSettings: ['admin_password_hash', 'import:matomo:site'],
} as const;

/** A v1 dashboard layout at layout-version 1 — the upgrade chain has work to do. */
const V1_OVERVIEW_LAYOUT = JSON.stringify({
  version: 1,
  name: 'Overview',
  site: 1,
  grid: [
    {
      id: 'kpis',
      viz: 'kpi-row',
      w: 12,
      h: 1,
      query: { id: 'k', metrics: ['visits', 'engaged_ms'] },
      options: {},
    },
    {
      id: 'pages',
      viz: 'bar-list',
      w: 6,
      h: 3,
      query: { id: 'p', metrics: ['pageviews'], dim: 'path' },
      options: {},
    },
  ],
});

/** A pre-versioning layout (no `version` key) — reads as the oldest there is. */
const V1_ALL_SITES_LAYOUT = JSON.stringify({
  name: 'All sites',
  site: 'all',
  grid: [
    {
      id: 'traffic',
      viz: 'timeseries',
      w: 12,
      h: 2,
      query: { id: 't', metrics: ['visits'], bucket: 'day' },
      options: {},
    },
  ],
});

interface FixtureEvent {
  site: number;
  ts: number;
  date: string;
  hour: number;
  type: string;
  visitor: number;
  session: number;
  seq: number;
  path?: string;
  utm?: [source: string | null, medium: string | null, campaign: string | null];
  category?: string;
  action?: string;
  value?: number;
  scroll?: number | null;
}

const T0 = Date.UTC(2026, 6, 1, 14); // 2026-07-01 14:00 UTC

const EVENTS: FixtureEvent[] = [
  // Site 1 (America/New_York), 2026-07-01 — visitor 1, session 11: an engaged
  // campaign visit whose utm values need normalization ('Google ' → 'google').
  {
    site: 1,
    ts: T0,
    date: '2026-07-01',
    hour: 10,
    type: 'pageview',
    visitor: 1,
    session: 11,
    seq: 1,
    path: '/',
    utm: ['Google ', 'CPC', 'Summer Sale'],
  },
  {
    site: 1,
    ts: T0 + 60_000,
    date: '2026-07-01',
    hour: 10,
    type: 'pageview',
    visitor: 1,
    session: 11,
    seq: 2,
    path: '/pricing',
    utm: ['Google ', 'CPC', 'Summer Sale'],
  },
  {
    site: 1,
    ts: T0 + 90_000,
    date: '2026-07-01',
    hour: 10,
    type: 'event',
    visitor: 1,
    session: 11,
    seq: 3,
    path: '/pricing',
    category: 'signup',
    action: 'click',
    value: 2.5,
  },
  {
    site: 1,
    ts: T0 + 120_000,
    date: '2026-07-01',
    hour: 10,
    type: 'ping',
    visitor: 1,
    session: 11,
    seq: 4,
    path: '/pricing',
    scroll: 80,
  },
  // Site 1, 2026-07-01 — visitor 2, session 12: a single-page bounce with no
  // utm whose path carries a Facebook click id, exactly as v1 stored real
  // in-app-browser traffic — the importer must clean the path and synthesize
  // facebook/social attribution from the click id (docs/03 § Attribution).
  {
    site: 1,
    ts: T0 + 3_600_000,
    date: '2026-07-01',
    hour: 11,
    type: 'pageview',
    visitor: 2,
    session: 12,
    seq: 1,
    path: '/blog?fbclid=IwAR1fixture',
  },
  // Site 1, 2026-07-02 — visitor 3, session 13: utm already canonical.
  {
    site: 1,
    ts: T0 + 90_000_000,
    date: '2026-07-02',
    hour: 11,
    type: 'pageview',
    visitor: 3,
    session: 13,
    seq: 1,
    path: '/',
    utm: ['newsletter', 'email', 'weekly'],
  },
  {
    site: 1,
    ts: T0 + 90_060_000,
    date: '2026-07-02',
    hour: 11,
    type: 'outlink',
    visitor: 3,
    session: 13,
    seq: 2,
    path: '/',
  },
  // Site 1, 2026-07-02 — visitor 4, session 14: 'AdWords' aliases to 'google'
  // once the target has the alias row; without one it lowercases to 'adwords'.
  {
    site: 1,
    ts: T0 + 95_000_000,
    date: '2026-07-02',
    hour: 12,
    type: 'pageview',
    visitor: 4,
    session: 14,
    seq: 1,
    path: '/pricing',
    utm: ['AdWords', 'cpc', 'summer sale'],
  },
  // Site 2 (UTC), both days — visitor 5 then 6.
  {
    site: 2,
    ts: T0 + 7_200_000,
    date: '2026-07-01',
    hour: 16,
    type: 'pageview',
    visitor: 5,
    session: 21,
    seq: 1,
    path: '/docs',
  },
  {
    site: 2,
    ts: T0 + 7_260_000,
    date: '2026-07-01',
    hour: 16,
    type: 'pageview',
    visitor: 5,
    session: 21,
    seq: 2,
    path: '/docs/api',
    scroll: 45,
  },
  {
    site: 2,
    ts: T0 + 93_600_000,
    date: '2026-07-02',
    hour: 16,
    type: 'pageview',
    visitor: 6,
    session: 22,
    seq: 1,
    path: '/docs',
  },
  {
    site: 2,
    ts: T0 + 93_660_000,
    date: '2026-07-02',
    hour: 16,
    type: 'ping',
    visitor: 6,
    session: 22,
    seq: 2,
    path: '/docs',
  },
];

interface FixtureSession {
  session: number;
  site: number;
  visitor: number;
  started: number;
  last: number;
  date: string;
  entry: string;
  exit: string;
  pageviews: number;
  events: number;
  engaged: number;
  utm?: [source: string | null, medium: string | null, campaign: string | null];
}

const SESSIONS: FixtureSession[] = [
  {
    session: 11,
    site: 1,
    visitor: 1,
    started: T0,
    last: T0 + 120_000,
    date: '2026-07-01',
    entry: '/',
    exit: '/pricing',
    pageviews: 2,
    events: 1,
    engaged: 120_000,
    utm: ['Google ', 'CPC', 'Summer Sale'],
  },
  {
    session: 12,
    site: 1,
    visitor: 2,
    started: T0 + 3_600_000,
    last: T0 + 3_600_000,
    date: '2026-07-01',
    entry: '/blog?fbclid=IwAR1fixture',
    exit: '/blog?fbclid=IwAR1fixture',
    pageviews: 1,
    events: 0,
    engaged: 0,
  },
  {
    session: 13,
    site: 1,
    visitor: 3,
    started: T0 + 90_000_000,
    last: T0 + 90_060_000,
    date: '2026-07-02',
    entry: '/',
    exit: '/',
    pageviews: 1,
    events: 0,
    engaged: 60_000,
    utm: ['newsletter', 'email', 'weekly'],
  },
  {
    session: 14,
    site: 1,
    visitor: 4,
    started: T0 + 95_000_000,
    last: T0 + 95_000_000,
    date: '2026-07-02',
    entry: '/pricing',
    exit: '/pricing',
    pageviews: 1,
    events: 0,
    engaged: 0,
    utm: ['AdWords', 'cpc', 'summer sale'],
  },
  {
    session: 21,
    site: 2,
    visitor: 5,
    started: T0 + 7_200_000,
    last: T0 + 7_260_000,
    date: '2026-07-01',
    entry: '/docs',
    exit: '/docs/api',
    pageviews: 2,
    events: 0,
    engaged: 60_000,
  },
  {
    session: 22,
    site: 2,
    visitor: 6,
    started: T0 + 93_600_000,
    last: T0 + 93_660_000,
    date: '2026-07-02',
    entry: '/docs',
    exit: '/docs',
    pageviews: 1,
    events: 0,
    engaged: 45_000,
  },
];

/** Seeds the deterministic miniature corpus `V1_FIXTURE` describes. */
export function seedV1Fixture(db: Db): void {
  db.prepare(
    'INSERT INTO sites (id, name, domains, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(1, 'One', '["one.test"]', 'America/New_York', T0 - 1_000_000_000);
  db.prepare(
    'INSERT INTO sites (id, name, domains, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(2, 'Two', '["two.test"]', 'UTC', T0 - 900_000_000);

  const insertEvent = db.prepare(`INSERT INTO events (
    site_id, ts, local_date, local_hour, type, visitor_id, session_id, seq,
    hostname, path, utm_source, utm_medium, utm_campaign,
    event_category, event_action, event_value, browser, os, device_type,
    country, scroll_pct
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of EVENTS) {
    insertEvent.run(
      e.site,
      e.ts,
      e.date,
      e.hour,
      e.type,
      bin(e.visitor),
      bin(e.session),
      e.seq,
      e.site === 1 ? 'one.test' : 'two.test',
      e.path ?? null,
      e.utm?.[0] ?? null,
      e.utm?.[1] ?? null,
      e.utm?.[2] ?? null,
      e.category ?? null,
      e.action ?? null,
      e.value ?? null,
      'Firefox',
      'macOS',
      'desktop',
      'US',
      e.scroll ?? null,
    );
  }

  const insertSession = db.prepare(`INSERT INTO sessions (
    id, site_id, visitor_id, started_at, last_seen_at, local_date,
    entry_path, exit_path, pageviews, events, engaged_ms,
    utm_source, utm_medium, utm_campaign, browser, os, device_type, country
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of SESSIONS) {
    insertSession.run(
      bin(s.session),
      s.site,
      bin(s.visitor),
      s.started,
      s.last,
      s.date,
      s.entry,
      s.exit,
      s.pageviews,
      s.events,
      s.engaged,
      s.utm?.[0] ?? null,
      s.utm?.[1] ?? null,
      s.utm?.[2] ?? null,
      'Firefox',
      'macOS',
      'desktop',
      'US',
    );
  }

  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(V1_FIXTURE.settings)) insertSetting.run(key, value);
  insertSetting.run('admin_password_hash', 'scrypt$fixture');
  insertSetting.run('import:matomo:site', '2');

  db.prepare('INSERT INTO bot_drops (site_id, local_date, count) VALUES (?, ?, ?)').run(
    1,
    '2026-07-01',
    7,
  );
  db.prepare('INSERT INTO bot_drops (site_id, local_date, count) VALUES (?, ?, ?)').run(
    2,
    '2026-07-02',
    3,
  );

  const insertDashboard = db.prepare(
    'INSERT INTO dashboards (id, name, site_scope, layout, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  insertDashboard.run(1, 'Overview', '1', V1_OVERVIEW_LAYOUT, T0 + 1_000_000);
  insertDashboard.run(2, 'All sites', 'all', V1_ALL_SITES_LAYOUT, T0 + 2_000_000);

  db.prepare(
    'INSERT INTO share_tokens (token_hash, dashboard_id, created_at) VALUES (?, ?, ?)',
  ).run(new Uint8Array(32).fill(9), 1, T0);
  db.prepare('INSERT INTO admin_sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(
    'f'.repeat(64),
    T0,
    T0 + 86_400_000,
  );
}

/** A seeded miniature v1 database — what every importer test starts from. */
export function createSeededV1Db(path = ':memory:'): Db {
  const db = createV1Db(path);
  seedV1Fixture(db);
  return db;
}
