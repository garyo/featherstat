import { type HitType, SiteDomainsSchema } from '@featherstat/shared';
import BetterSqlite3 from 'better-sqlite3';
import { type Db, migrate } from './migrate.ts';

export { type Db, type Migration, migrate, schemaVersion } from './migrate.ts';

/** Matches the `sites.timezone` column default (docs/03). */
export const DEFAULT_TIMEZONE = 'America/New_York';

// ---------------------------------------------------------------------------
// Row types — server-internal. Keys are the column names of docs/03 verbatim,
// so this layer needs no name mapping and drift shows up as a type error.
// Optional properties are the nullable columns; omit what a row doesn't have.
// ---------------------------------------------------------------------------

export interface Site {
  id: number;
  name: string;
  /** Decoded from the `domains` JSON column; first entry is canonical. */
  domains: string[];
  timezone: string;
  created_at: number;
}

export interface NewSite {
  /** Preserved from Matomo on import; assigned by SQLite when omitted. */
  id?: number;
  name: string;
  domains: readonly string[];
  timezone?: string;
  created_at?: number;
}

export interface EventRow {
  site_id: number;
  ts: number;
  local_date: string;
  local_hour: number;
  type: HitType;
  /** 8 bytes, daily-rotating. */
  visitor_id: Uint8Array;
  /** 8 random bytes. */
  session_id: Uint8Array;
  /** 1-based position within its session. */
  seq: number;

  hostname?: string | null;
  path?: string | null;
  title?: string | null;
  target_url?: string | null;

  ref_domain?: string | null;
  ref_type?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;

  event_category?: string | null;
  event_action?: string | null;
  event_name?: string | null;
  event_value?: number | null;

  browser?: string | null;
  browser_version?: string | null;
  os?: string | null;
  device_type?: string | null;
  screen?: string | null;
  lang?: string | null;

  country?: string | null;
  region?: string | null;
  city?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** 0–100 from the native tracker's pings; null is unmeasured, never 0 (docs/04 § 2). */
  scroll_pct?: number | null;
}

export interface SessionRow {
  id: Uint8Array;
  site_id: number;
  visitor_id: Uint8Array;
  started_at: number;
  last_seen_at: number;
  local_date: string;
  pageviews: number;
  events: number;
  engaged_ms: number;

  entry_path?: string | null;
  exit_path?: string | null;

  ref_domain?: string | null;
  ref_type?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;

  browser?: string | null;
  os?: string | null;
  device_type?: string | null;

  country?: string | null;
  region?: string | null;
  city?: string | null;
}

type NullableKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];
/** A value for every nullable column, so a row may omit them (SQLite binding needs all names). */
type NullFill<T> = { readonly [K in NullableKeys<T>]: null };

const EVENT_NULLS: NullFill<EventRow> = {
  hostname: null,
  path: null,
  title: null,
  target_url: null,
  ref_domain: null,
  ref_type: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  event_category: null,
  event_action: null,
  event_name: null,
  event_value: null,
  browser: null,
  browser_version: null,
  os: null,
  device_type: null,
  screen: null,
  lang: null,
  country: null,
  region: null,
  city: null,
  lat: null,
  lon: null,
  scroll_pct: null,
};

const SESSION_NULLS: NullFill<SessionRow> = {
  entry_path: null,
  exit_path: null,
  ref_domain: null,
  ref_type: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  browser: null,
  os: null,
  device_type: null,
  country: null,
  region: null,
  city: null,
};

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Opens (creating if needed) and migrates the database. `path` may be ':memory:'. */
export function openDb(path: string): Db {
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

const writeObservers = new WeakMap<Db, Set<(ms: number) => void>>();

/**
 * Times every top-level write transaction on `db` — in steady state that is the
 * batcher's flush, so this is the `/metrics` flush-duration feed. Nested
 * transactions (savepoints) are not re-observed.
 */
export function observeWriteTransactions(db: Db, observer: (ms: number) => void): () => void {
  let observers = writeObservers.get(db);
  if (observers === undefined) {
    observers = new Set();
    writeObservers.set(db, observers);
  }
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/**
 * The only way to write. Single-writer discipline (docs/02): the ingest batcher wraps
 * each 200 ms flush in one of these; everything else is a read. Nests safely (savepoints).
 */
export function withWriteTransaction<T>(db: Db, fn: () => T): T {
  const observers = writeObservers.get(db);
  if (observers === undefined || observers.size === 0 || db.inTransaction) {
    return db.transaction(fn).immediate();
  }
  const started = performance.now();
  try {
    return db.transaction(fn).immediate();
  } finally {
    const ms = performance.now() - started;
    for (const observer of observers) observer(ms);
  }
}

/**
 * One consistent read snapshot for every query inside `fn` (the query engine wraps
 * each `/api/query` batch in one). BEGIN DEFERRED with reads only never takes the
 * write lock, so this does not touch the single-writer discipline above.
 */
export function withReadSnapshot<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).deferred();
}

function assertWritable(db: Db): void {
  if (!db.inTransaction) {
    throw new Error('DB writes must run inside withWriteTransaction() — see docs/02 single writer');
  }
}

const statementCache = new WeakMap<Db, Map<string, BetterSqlite3.Statement>>();

/** Prepared statements are per-connection and reused; hot paths (ingest, query) prepare nothing. */
export function stmt<Result = unknown>(
  db: Db,
  sql: string,
): BetterSqlite3.Statement<unknown[], Result> {
  let bySql = statementCache.get(db);
  if (bySql === undefined) {
    bySql = new Map();
    statementCache.set(db, bySql);
  }
  let prepared = bySql.get(sql);
  if (prepared === undefined) {
    prepared = db.prepare(sql);
    bySql.set(sql, prepared);
  }
  return prepared as BetterSqlite3.Statement<unknown[], Result>;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

interface SiteColumns {
  id: number;
  name: string;
  domains: string;
  timezone: string;
  created_at: number;
}

const SQL_LIST_SITES = 'SELECT id, name, domains, timezone, created_at FROM sites ORDER BY id';
const SQL_GET_SITE = 'SELECT id, name, domains, timezone, created_at FROM sites WHERE id = ?';
const SQL_CREATE_SITE =
  'INSERT INTO sites (id, name, domains, timezone, created_at) VALUES (?, ?, ?, ?, ?)';

export function listSites(db: Db): Site[] {
  return stmt<SiteColumns>(db, SQL_LIST_SITES).all().map(decodeSite);
}

export function getSite(db: Db, id: number): Site | undefined {
  const row = stmt<SiteColumns>(db, SQL_GET_SITE).get(id);
  return row === undefined ? undefined : decodeSite(row);
}

export function createSite(db: Db, site: NewSite): Site {
  assertWritable(db);
  const domains = [...site.domains];
  const timezone = site.timezone ?? DEFAULT_TIMEZONE;
  const created_at = site.created_at ?? Date.now();
  const info = stmt(db, SQL_CREATE_SITE).run(
    site.id ?? null,
    site.name,
    JSON.stringify(domains),
    timezone,
    created_at,
  );
  return {
    id: site.id ?? Number(info.lastInsertRowid),
    name: site.name,
    domains,
    timezone,
    created_at,
  };
}

/** Admin edits (docs/04 § 5): name, domains and timezone move; id and created_at never do. */
export interface SitePatch {
  name?: string;
  domains?: readonly string[];
  timezone?: string;
}

const SQL_UPDATE_SITE =
  'UPDATE sites SET name = ?, domains = ?, timezone = ? WHERE id = ? RETURNING id, name, domains, timezone, created_at';

export function updateSite(db: Db, id: number, patch: SitePatch): Site | undefined {
  assertWritable(db);
  const current = getSite(db, id);
  if (current === undefined) return undefined;
  const next = {
    name: patch.name ?? current.name,
    domains: patch.domains === undefined ? current.domains : [...patch.domains],
    timezone: patch.timezone ?? current.timezone,
  };
  const row = stmt<SiteColumns>(db, SQL_UPDATE_SITE).get(
    next.name,
    JSON.stringify(next.domains),
    next.timezone,
    id,
  );
  return row === undefined ? undefined : decodeSite(row);
}

function decodeSite(row: SiteColumns): Site {
  return { ...row, domains: SiteDomainsSchema.parse(JSON.parse(row.domains)) };
}

// ---------------------------------------------------------------------------
// Events & sessions (batcher-owned)
// ---------------------------------------------------------------------------

const SQL_INSERT_EVENT = `INSERT INTO events (
  site_id, ts, local_date, local_hour, type, visitor_id, session_id, seq,
  hostname, path, title, target_url,
  ref_domain, ref_type, utm_source, utm_medium, utm_campaign,
  event_category, event_action, event_name, event_value,
  browser, browser_version, os, device_type, screen, lang,
  country, region, city, lat, lon, scroll_pct
) VALUES (
  @site_id, @ts, @local_date, @local_hour, @type, @visitor_id, @session_id, @seq,
  @hostname, @path, @title, @target_url,
  @ref_domain, @ref_type, @utm_source, @utm_medium, @utm_campaign,
  @event_category, @event_action, @event_name, @event_value,
  @browser, @browser_version, @os, @device_type, @screen, @lang,
  @country, @region, @city, @lat, @lon, @scroll_pct
)`;

/** Counters and exit state are re-sent in full by the sessionizer; first-touch columns stick. */
const SQL_UPSERT_SESSION = `INSERT INTO sessions (
  id, site_id, visitor_id, started_at, last_seen_at, local_date,
  entry_path, exit_path, pageviews, events, engaged_ms,
  ref_domain, ref_type, utm_source, utm_medium, utm_campaign,
  browser, os, device_type, country, region, city
) VALUES (
  @id, @site_id, @visitor_id, @started_at, @last_seen_at, @local_date,
  @entry_path, @exit_path, @pageviews, @events, @engaged_ms,
  @ref_domain, @ref_type, @utm_source, @utm_medium, @utm_campaign,
  @browser, @os, @device_type, @country, @region, @city
)
ON CONFLICT (id) DO UPDATE SET
  last_seen_at = excluded.last_seen_at,
  exit_path    = excluded.exit_path,
  pageviews    = excluded.pageviews,
  events       = excluded.events,
  engaged_ms   = excluded.engaged_ms`;

export function insertEvents(db: Db, rows: readonly EventRow[]): void {
  assertWritable(db);
  const insert = stmt(db, SQL_INSERT_EVENT);
  for (const row of rows) insert.run({ ...EVENT_NULLS, ...row });
}

export function upsertSessions(db: Db, rows: readonly SessionRow[]): void {
  assertWritable(db);
  const upsert = stmt(db, SQL_UPSERT_SESSION);
  for (const row of rows) upsert.run({ ...SESSION_NULLS, ...row });
}

const SQL_DATA_VERSION = 'SELECT COALESCE(MAX(id), 0) FROM events';

/**
 * Insert-only history moves MAX(events.id); in-place rewrites (alias backfill,
 * prop scrub, site purge, rollup rebuild) do not, so each of those bumps the
 * epoch instead — otherwise every ETag computed before the rewrite would keep
 * answering 304 forever. 2^40 rowids per epoch keeps the combined value well
 * inside Number.MAX_SAFE_INTEGER for any plausible bump count.
 */
const EPOCH_SETTING = 'data_epoch';
const EPOCH_STRIDE = 2 ** 40;

/** Epoch-stridden MAX(events.id): the data version for ETags (docs/03). */
export function dataVersion(db: Db): number {
  const maxId = stmt(db, SQL_DATA_VERSION).pluck().get() as number;
  const epoch = Number(getSetting(db, EPOCH_SETTING) ?? 0);
  return epoch * EPOCH_STRIDE + maxId;
}

/** Every history-rewriting job calls this once, after its last chunk commits. */
export function bumpDataEpoch(db: Db): void {
  assertWritable(db);
  const epoch = Number(getSetting(db, EPOCH_SETTING) ?? 0);
  setSetting(db, EPOCH_SETTING, String(epoch + 1));
}

/** Restart recovery (docs/03): sessions seen since `since`, with their highest stored seq. */
const SQL_OPEN_SESSIONS = `SELECT s.*,
  (SELECT COALESCE(MAX(e.seq), 0) FROM events e WHERE e.session_id = s.id) AS max_seq
FROM sessions s WHERE s.last_seen_at >= ?`;

export function selectOpenSessions(db: Db, since: number): Array<SessionRow & { max_seq: number }> {
  return stmt<SessionRow & { max_seq: number }>(db, SQL_OPEN_SESSIONS).all(since) as Array<
    SessionRow & { max_seq: number }
  >;
}

/**
 * Session revival (docs/03): one visitor's most recent session, no older than
 * `since`. Read-only and rare — a heartbeat with no live session — and served
 * whole by `ix_sessions_open (site_id, visitor_id, last_seen_at)`.
 */
const SQL_LATEST_SESSION = `SELECT s.*,
  (SELECT COALESCE(MAX(e.seq), 0) FROM events e WHERE e.session_id = s.id) AS max_seq
FROM sessions s
WHERE s.site_id = ? AND s.visitor_id = ? AND s.last_seen_at >= ?
ORDER BY s.last_seen_at DESC LIMIT 1`;

export function selectLatestSession(
  db: Db,
  siteId: number,
  visitorId: Uint8Array,
  since: number,
): (SessionRow & { max_seq: number }) | undefined {
  return stmt<SessionRow & { max_seq: number }>(db, SQL_LATEST_SESSION).get(
    siteId,
    visitorId,
    since,
  ) as (SessionRow & { max_seq: number }) | undefined;
}

// ---------------------------------------------------------------------------
// Settings & diagnostics counters
// ---------------------------------------------------------------------------

const SQL_GET_SETTING = 'SELECT value FROM settings WHERE key = ?';
const SQL_SETTING_KEYS = "SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\' ORDER BY key";
const SQL_SET_SETTING =
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
const SQL_DELETE_SETTING = 'DELETE FROM settings WHERE key = ?';

export function getSetting(db: Db, key: string): string | undefined {
  return stmt<{ value: string | null }>(db, SQL_GET_SETTING).get(key)?.value ?? undefined;
}

export function settingKeysWithPrefix(db: Db, prefix: string): string[] {
  const escaped = prefix.replace(/[%_\\]/g, '\\$&'); // a literal prefix, not a LIKE pattern
  return stmt<string>(db, SQL_SETTING_KEYS).pluck().all(`${escaped}%`) as string[];
}

export function setSetting(db: Db, key: string, value: string): void {
  assertWritable(db);
  stmt(db, SQL_SET_SETTING).run(key, value);
}

export function deleteSetting(db: Db, key: string): void {
  assertWritable(db);
  stmt(db, SQL_DELETE_SETTING).run(key);
}

const SQL_INCREMENT_BOT_DROPS = `INSERT INTO bot_drops (site_id, local_date, count) VALUES (?, ?, ?)
ON CONFLICT (site_id, local_date) DO UPDATE SET count = count + excluded.count`;
const SQL_GET_BOT_DROPS = 'SELECT count FROM bot_drops WHERE site_id = ? AND local_date = ?';

export function incrementBotDrops(db: Db, siteId: number, localDate: string, count = 1): void {
  assertWritable(db);
  stmt(db, SQL_INCREMENT_BOT_DROPS).run(siteId, localDate, count);
}

export function getBotDrops(db: Db, siteId: number, localDate: string): number {
  return stmt<{ count: number }>(db, SQL_GET_BOT_DROPS).get(siteId, localDate)?.count ?? 0;
}

export interface BotDropRow {
  site_id: number;
  local_date: string;
  count: number;
}

const SQL_LIST_BOT_DROPS =
  'SELECT site_id, local_date, count FROM bot_drops WHERE local_date >= ? ORDER BY local_date DESC, site_id';

/** Diagnostics (docs/04 § 5): per-site bot-drop counters since a local date (inclusive). */
export function listBotDrops(db: Db, sinceLocalDate: string): BotDropRow[] {
  return stmt<BotDropRow>(db, SQL_LIST_BOT_DROPS).all(sinceLocalDate) as BotDropRow[];
}

const SQL_COUNT_EVENTS = 'SELECT COUNT(*) FROM events';

export function countEvents(db: Db): number {
  return stmt(db, SQL_COUNT_EVENTS).pluck().get() as number;
}

/** Page math rather than fs.stat, so :memory: databases (tests) answer too. */
export function databaseSizeBytes(db: Db): number {
  const pages = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return pages * pageSize;
}

// ---------------------------------------------------------------------------
// Dashboards & share tokens (docs/04 § 5, docs/05 § Widgets)
// ---------------------------------------------------------------------------

export interface DashboardRow {
  id: number;
  /** Denormalized from the layout for listing without a JSON parse. */
  name: string;
  /** `'all'` or a site id in decimal — the layout's `site`, stringified. */
  site_scope: string;
  /** Dashboard JSON; the routes validate with `DashboardSchema` before every write. */
  layout: string;
  updated_at: number;
}

export type NewDashboard = Omit<DashboardRow, 'id'>;

const DASHBOARD_COLUMNS = 'id, name, site_scope, layout, updated_at';
const SQL_LIST_DASHBOARDS = `SELECT ${DASHBOARD_COLUMNS} FROM dashboards ORDER BY id`;
const SQL_GET_DASHBOARD = `SELECT ${DASHBOARD_COLUMNS} FROM dashboards WHERE id = ?`;
const SQL_CREATE_DASHBOARD =
  'INSERT INTO dashboards (name, site_scope, layout, updated_at, created_at) VALUES (?, ?, ?, ?, ?)';
const SQL_UPDATE_DASHBOARD = `UPDATE dashboards SET name = ?, site_scope = ?, layout = ?, updated_at = ?
WHERE id = ? RETURNING ${DASHBOARD_COLUMNS}`;
const SQL_DELETE_DASHBOARD = 'DELETE FROM dashboards WHERE id = ?';
const SQL_DELETE_DASHBOARD_TOKENS = 'DELETE FROM share_tokens WHERE dashboard_id = ?';

export function listDashboards(db: Db): DashboardRow[] {
  return stmt<DashboardRow>(db, SQL_LIST_DASHBOARDS).all() as DashboardRow[];
}

export function getDashboard(db: Db, id: number): DashboardRow | undefined {
  return stmt<DashboardRow>(db, SQL_GET_DASHBOARD).get(id);
}

export function createDashboard(db: Db, row: NewDashboard): DashboardRow {
  assertWritable(db);
  const info = stmt(db, SQL_CREATE_DASHBOARD).run(
    row.name,
    row.site_scope,
    row.layout,
    row.updated_at,
    row.updated_at, // created_at: a fresh row's clocks start together
  );
  return { id: Number(info.lastInsertRowid), ...row };
}

export function updateDashboard(db: Db, id: number, row: NewDashboard): DashboardRow | undefined {
  assertWritable(db);
  return stmt<DashboardRow>(db, SQL_UPDATE_DASHBOARD).get(
    row.name,
    row.site_scope,
    row.layout,
    row.updated_at,
    id,
  );
}

/** Removes the dashboard and every share token pointing at it; false if unknown. */
export function deleteDashboard(db: Db, id: number): boolean {
  assertWritable(db);
  stmt(db, SQL_DELETE_DASHBOARD_TOKENS).run(id);
  return stmt(db, SQL_DELETE_DASHBOARD).run(id).changes > 0;
}

export interface ShareTokenRow {
  /** sha256 of the raw token — the raw value exists only in the mint response. */
  token_hash: Uint8Array;
  dashboard_id: number;
  created_at: number;
  revoked_at: number | null;
}

const SQL_INSERT_SHARE_TOKEN =
  'INSERT INTO share_tokens (token_hash, dashboard_id, created_at) VALUES (?, ?, ?)';
const SQL_GET_SHARE_TOKEN =
  'SELECT token_hash, dashboard_id, created_at, revoked_at FROM share_tokens WHERE token_hash = ?';
const SQL_REVOKE_SHARE_TOKENS =
  'UPDATE share_tokens SET revoked_at = ? WHERE dashboard_id = ? AND revoked_at IS NULL';

export function insertShareToken(db: Db, row: Omit<ShareTokenRow, 'revoked_at'>): void {
  assertWritable(db);
  stmt(db, SQL_INSERT_SHARE_TOKEN).run(row.token_hash, row.dashboard_id, row.created_at);
}

export function getShareToken(db: Db, tokenHash: Uint8Array): ShareTokenRow | undefined {
  return stmt<ShareTokenRow>(db, SQL_GET_SHARE_TOKEN).get(tokenHash);
}

/** Revokes every live token of a dashboard; returns how many were revoked. */
export function revokeShareTokens(db: Db, dashboardId: number, now: number): number {
  assertWritable(db);
  return stmt(db, SQL_REVOKE_SHARE_TOKENS).run(now, dashboardId).changes;
}

// ---------------------------------------------------------------------------
// Admin sessions (docs/02 § Security posture)
// ---------------------------------------------------------------------------

export interface AdminSessionRow {
  id: string;
  created_at: number;
  expires_at: number;
}

const SQL_INSERT_ADMIN_SESSION =
  'INSERT INTO admin_sessions (id, created_at, expires_at) VALUES (?, ?, ?)';
const SQL_GET_ADMIN_SESSION = 'SELECT id, created_at, expires_at FROM admin_sessions WHERE id = ?';
const SQL_DELETE_ADMIN_SESSION = 'DELETE FROM admin_sessions WHERE id = ?';
const SQL_DELETE_ADMIN_SESSIONS_EXCEPT = 'DELETE FROM admin_sessions WHERE id <> ?';
const SQL_DELETE_EXPIRED_ADMIN_SESSIONS = 'DELETE FROM admin_sessions WHERE expires_at <= ?';

export function insertAdminSession(db: Db, row: AdminSessionRow): void {
  assertWritable(db);
  stmt(db, SQL_INSERT_ADMIN_SESSION).run(row.id, row.created_at, row.expires_at);
}

export function getAdminSession(db: Db, id: string): AdminSessionRow | undefined {
  return stmt<AdminSessionRow>(db, SQL_GET_ADMIN_SESSION).get(id);
}

export function deleteAdminSession(db: Db, id: string): void {
  assertWritable(db);
  stmt(db, SQL_DELETE_ADMIN_SESSION).run(id);
}

/** Password change: every other device is logged out; the changing session stays. */
export function deleteAdminSessionsExcept(db: Db, keepId: string): void {
  assertWritable(db);
  stmt(db, SQL_DELETE_ADMIN_SESSIONS_EXCEPT).run(keepId);
}

export function deleteExpiredAdminSessions(db: Db, now: number): void {
  assertWritable(db);
  stmt(db, SQL_DELETE_EXPIRED_ADMIN_SESSIONS).run(now);
}
