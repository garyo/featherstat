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
  /** As received, ONLY when normalization changed it — near-always absent (docs/03 § Campaigns). */
  utm_source_raw?: string | null;
  utm_medium_raw?: string | null;
  utm_campaign_raw?: string | null;

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
  /** Canonical JSON (sorted keys, no whitespace) from the prop registry; null = no bag —
   * an empty `{}` is never stored (docs/03 § Props). */
  props?: string | null;
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
  /** First-touch, like the normalized columns beside them. */
  utm_source_raw?: string | null;
  utm_medium_raw?: string | null;
  utm_campaign_raw?: string | null;

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
  utm_source_raw: null,
  utm_medium_raw: null,
  utm_campaign_raw: null,
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
  props: null,
};

const SESSION_NULLS: NullFill<SessionRow> = {
  entry_path: null,
  exit_path: null,
  ref_domain: null,
  ref_type: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_source_raw: null,
  utm_medium_raw: null,
  utm_campaign_raw: null,
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

export function assertWritable(db: Db): void {
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
  utm_source_raw, utm_medium_raw, utm_campaign_raw,
  event_category, event_action, event_name, event_value,
  browser, browser_version, os, device_type, screen, lang,
  country, region, city, lat, lon, scroll_pct, props
) VALUES (
  @site_id, @ts, @local_date, @local_hour, @type, @visitor_id, @session_id, @seq,
  @hostname, @path, @title, @target_url,
  @ref_domain, @ref_type, @utm_source, @utm_medium, @utm_campaign,
  @utm_source_raw, @utm_medium_raw, @utm_campaign_raw,
  @event_category, @event_action, @event_name, @event_value,
  @browser, @browser_version, @os, @device_type, @screen, @lang,
  @country, @region, @city, @lat, @lon, @scroll_pct, @props
)`;

/** Counters and exit state are re-sent in full by the sessionizer; first-touch columns stick. */
const SQL_UPSERT_SESSION = `INSERT INTO sessions (
  id, site_id, visitor_id, started_at, last_seen_at, local_date,
  entry_path, exit_path, pageviews, events, engaged_ms,
  ref_domain, ref_type, utm_source, utm_medium, utm_campaign,
  utm_source_raw, utm_medium_raw, utm_campaign_raw,
  browser, os, device_type, country, region, city
) VALUES (
  @id, @site_id, @visitor_id, @started_at, @last_seen_at, @local_date,
  @entry_path, @exit_path, @pageviews, @events, @engaged_ms,
  @ref_domain, @ref_type, @utm_source, @utm_medium, @utm_campaign,
  @utm_source_raw, @utm_medium_raw, @utm_campaign_raw,
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

// ---------------------------------------------------------------------------
// Props governance (docs/03 § Props) — admin reads + the delete the scrub rides.
// The write path (upserts, drop counters) lives with the registry in
// pipeline/props.ts; these are the rows the settings view lists.
// ---------------------------------------------------------------------------

export interface PropKeyRow {
  key: string;
  first_seen: number;
  last_seen: number;
  events: number;
  distinct_values: number;
  over_cap_since: number | null;
}

const SQL_LIST_PROP_KEYS = `SELECT key, first_seen, last_seen, events, distinct_values, over_cap_since
FROM prop_keys WHERE site_id = ? ORDER BY key`;

export function listPropKeys(db: Db, siteId: number): PropKeyRow[] {
  return stmt<PropKeyRow>(db, SQL_LIST_PROP_KEYS).all(siteId) as PropKeyRow[];
}

export interface PropDropRow {
  local_date: string;
  reason: string;
  count: number;
}

const SQL_LIST_PROP_DROPS = `SELECT local_date, reason, count FROM prop_drops
WHERE site_id = ? AND local_date >= ? ORDER BY local_date DESC, reason`;

export function listPropDrops(db: Db, siteId: number, sinceLocalDate: string): PropDropRow[] {
  return stmt<PropDropRow>(db, SQL_LIST_PROP_DROPS).all(siteId, sinceLocalDate) as PropDropRow[];
}

const SQL_DELETE_PROP_KEY = 'DELETE FROM prop_keys WHERE site_id = ? AND key = ?';
const SQL_DELETE_PROP_VALUES = 'DELETE FROM prop_values WHERE site_id = ? AND key = ?';

/** Removes one key's governance rows; true if the key existed. The stored bags
 * are the scrub job's to clean (jobs/prop-scrub.ts). */
export function deletePropKey(db: Db, siteId: number, key: string): boolean {
  assertWritable(db);
  const existed = stmt(db, SQL_DELETE_PROP_KEY).run(siteId, key).changes > 0;
  stmt(db, SQL_DELETE_PROP_VALUES).run(siteId, key);
  return existed;
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
// Segments & derived metrics (docs/04 § 3): stored query-layer objects.
// Both hold client-authored text the routes validate on write; readers
// re-parse (SegmentFilterNodeSchema / parseDerivedExpr) and fail closed.
// ---------------------------------------------------------------------------

export interface SegmentRow {
  id: number;
  name: string;
  /** One FilterNode as JSON — never a segment ref (no cycles by construction). */
  filter: string;
  updated_at: number;
}

const SEGMENT_COLUMNS = 'id, name, filter, updated_at';
const SQL_LIST_SEGMENTS = `SELECT ${SEGMENT_COLUMNS} FROM segments ORDER BY id`;
const SQL_GET_SEGMENT = `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE id = ?`;
const SQL_CREATE_SEGMENT =
  'INSERT INTO segments (name, filter, created_at, updated_at) VALUES (?, ?, ?, ?)';
const SQL_UPDATE_SEGMENT = `UPDATE segments SET name = ?, filter = ?, updated_at = ?
WHERE id = ? RETURNING ${SEGMENT_COLUMNS}`;
const SQL_DELETE_SEGMENT = 'DELETE FROM segments WHERE id = ?';

export function listSegments(db: Db): SegmentRow[] {
  return stmt<SegmentRow>(db, SQL_LIST_SEGMENTS).all() as SegmentRow[];
}

export function getSegment(db: Db, id: number): SegmentRow | undefined {
  return stmt<SegmentRow>(db, SQL_GET_SEGMENT).get(id);
}

export function createSegment(db: Db, name: string, filter: string, now: number): SegmentRow {
  assertWritable(db);
  const info = stmt(db, SQL_CREATE_SEGMENT).run(name, filter, now, now);
  return { id: Number(info.lastInsertRowid), name, filter, updated_at: now };
}

export function updateSegment(
  db: Db,
  id: number,
  name: string,
  filter: string,
  now: number,
): SegmentRow | undefined {
  assertWritable(db);
  return stmt<SegmentRow>(db, SQL_UPDATE_SEGMENT).get(name, filter, now, id);
}

export function deleteSegment(db: Db, id: number): boolean {
  assertWritable(db);
  return stmt(db, SQL_DELETE_SEGMENT).run(id).changes > 0;
}

export interface DerivedMetricRow {
  id: number;
  name: string;
  /** Arithmetic over metric names — parsed by `parseDerivedExpr`, never eval'd. */
  expr: string;
  updated_at: number;
}

const DERIVED_COLUMNS = 'id, name, expr, updated_at';
const SQL_LIST_DERIVED = `SELECT ${DERIVED_COLUMNS} FROM derived_metrics ORDER BY id`;
const SQL_GET_DERIVED = `SELECT ${DERIVED_COLUMNS} FROM derived_metrics WHERE id = ?`;
const SQL_GET_DERIVED_BY_NAME = `SELECT ${DERIVED_COLUMNS} FROM derived_metrics WHERE name = ?`;
const SQL_CREATE_DERIVED =
  'INSERT INTO derived_metrics (name, expr, created_at, updated_at) VALUES (?, ?, ?, ?)';
const SQL_UPDATE_DERIVED = `UPDATE derived_metrics SET name = ?, expr = ?, updated_at = ?
WHERE id = ? RETURNING ${DERIVED_COLUMNS}`;
const SQL_DELETE_DERIVED = 'DELETE FROM derived_metrics WHERE id = ?';

export function listDerivedMetrics(db: Db): DerivedMetricRow[] {
  return stmt<DerivedMetricRow>(db, SQL_LIST_DERIVED).all() as DerivedMetricRow[];
}

export function getDerivedMetric(db: Db, id: number): DerivedMetricRow | undefined {
  return stmt<DerivedMetricRow>(db, SQL_GET_DERIVED).get(id);
}

export function getDerivedMetricByName(db: Db, name: string): DerivedMetricRow | undefined {
  return stmt<DerivedMetricRow>(db, SQL_GET_DERIVED_BY_NAME).get(name);
}

export function createDerivedMetric(
  db: Db,
  name: string,
  expr: string,
  now: number,
): DerivedMetricRow {
  assertWritable(db);
  const info = stmt(db, SQL_CREATE_DERIVED).run(name, expr, now, now);
  return { id: Number(info.lastInsertRowid), name, expr, updated_at: now };
}

export function updateDerivedMetric(
  db: Db,
  id: number,
  name: string,
  expr: string,
  now: number,
): DerivedMetricRow | undefined {
  assertWritable(db);
  return stmt<DerivedMetricRow>(db, SQL_UPDATE_DERIVED).get(name, expr, now, id);
}

export function deleteDerivedMetric(db: Db, id: number): boolean {
  assertWritable(db);
  return stmt(db, SQL_DELETE_DERIVED).run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Campaign layer (docs/03 § Campaigns): alias rows the ingest normalizer and
// the backfill job read, and the registry `campaign_status` reads at query time.
// ---------------------------------------------------------------------------

export interface CampaignAliasRow {
  site_id: number;
  /** 'source' | 'medium' | 'campaign'. */
  field: string;
  /** Matched AFTER canonicalization (trim/collapse/lowercase). */
  alias: string;
  canonical: string;
}

const ALIAS_COLUMNS = 'site_id, field, alias, canonical';
const SQL_ALL_CAMPAIGN_ALIASES = `SELECT ${ALIAS_COLUMNS} FROM campaign_aliases`;
const SQL_LIST_CAMPAIGN_ALIASES = `SELECT ${ALIAS_COLUMNS} FROM campaign_aliases
WHERE site_id = ? ORDER BY field, alias`;
const SQL_DELETE_CAMPAIGN_ALIASES = 'DELETE FROM campaign_aliases WHERE site_id = ?';
const SQL_INSERT_CAMPAIGN_ALIAS =
  'INSERT INTO campaign_aliases (site_id, field, alias, canonical) VALUES (?, ?, ?, ?)';

/** Every alias row of every site — what the ingest cache loads whole (it is tiny). */
export function listAllCampaignAliases(db: Db): CampaignAliasRow[] {
  return stmt<CampaignAliasRow>(db, SQL_ALL_CAMPAIGN_ALIASES).all() as CampaignAliasRow[];
}

/** One site's alias rows (site 0 = install-wide). */
export function listCampaignAliases(db: Db, siteId: number): CampaignAliasRow[] {
  return stmt<CampaignAliasRow>(db, SQL_LIST_CAMPAIGN_ALIASES).all(siteId) as CampaignAliasRow[];
}

/** Full-list replace for one site — the PUT route's semantics. */
export function replaceCampaignAliases(
  db: Db,
  siteId: number,
  rows: readonly Pick<CampaignAliasRow, 'field' | 'alias' | 'canonical'>[],
): void {
  assertWritable(db);
  stmt(db, SQL_DELETE_CAMPAIGN_ALIASES).run(siteId);
  const insert = stmt(db, SQL_INSERT_CAMPAIGN_ALIAS);
  for (const row of rows) insert.run(siteId, row.field, row.alias, row.canonical);
}

export interface CampaignRow {
  id: number;
  site_id: number;
  /** The canonical utm_campaign value. */
  name: string;
  /** JSON arrays; NULL = anything. */
  expected_sources: string | null;
  expected_mediums: string | null;
  /** Site-local dates; NULL = open. */
  starts_at: string | null;
  ends_at: string | null;
  notes: string | null;
  created_at: number;
}

const CAMPAIGN_COLUMNS =
  'id, site_id, name, expected_sources, expected_mediums, starts_at, ends_at, notes, created_at';
const SQL_LIST_CAMPAIGNS = `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE site_id = ? ORDER BY id`;
const SQL_GET_CAMPAIGN = `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE id = ?`;
const SQL_CREATE_CAMPAIGN = `INSERT INTO campaigns
  (site_id, name, expected_sources, expected_mediums, starts_at, ends_at, notes, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_UPDATE_CAMPAIGN = `UPDATE campaigns SET name = ?, expected_sources = ?,
  expected_mediums = ?, starts_at = ?, ends_at = ?, notes = ?
WHERE id = ? RETURNING ${CAMPAIGN_COLUMNS}`;
const SQL_DELETE_CAMPAIGN = 'DELETE FROM campaigns WHERE id = ?';

export function listCampaigns(db: Db, siteId: number): CampaignRow[] {
  return stmt<CampaignRow>(db, SQL_LIST_CAMPAIGNS).all(siteId) as CampaignRow[];
}

export function getCampaign(db: Db, id: number): CampaignRow | undefined {
  return stmt<CampaignRow>(db, SQL_GET_CAMPAIGN).get(id);
}

export type NewCampaign = Omit<CampaignRow, 'id'>;

export function createCampaign(db: Db, row: NewCampaign): CampaignRow {
  assertWritable(db);
  const info = stmt(db, SQL_CREATE_CAMPAIGN).run(
    row.site_id,
    row.name,
    row.expected_sources,
    row.expected_mediums,
    row.starts_at,
    row.ends_at,
    row.notes,
    row.created_at,
  );
  return { id: Number(info.lastInsertRowid), ...row };
}

export function updateCampaign(
  db: Db,
  id: number,
  patch: Omit<NewCampaign, 'site_id' | 'created_at'>,
): CampaignRow | undefined {
  assertWritable(db);
  return stmt<CampaignRow>(db, SQL_UPDATE_CAMPAIGN).get(
    patch.name,
    patch.expected_sources,
    patch.expected_mediums,
    patch.starts_at,
    patch.ends_at,
    patch.notes,
    id,
  );
}

export function deleteCampaign(db: Db, id: number): boolean {
  assertWritable(db);
  return stmt(db, SQL_DELETE_CAMPAIGN).run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Goals (docs/04 § 3): stored saved-query rows. Like segments, the stored
// filters are client-authored JSON — validated on write, re-parsed on read.
// ---------------------------------------------------------------------------

export interface GoalRow {
  id: number;
  site_id: number;
  name: string;
  /** JSON array of FilterNode (no segment refs). */
  filters: string;
  /** 'event_value' | 'fixed:<number>' | NULL — parseGoalValueExpr decodes. */
  value_expr: string | null;
  target: number | null;
  updated_at: number;
}

const GOAL_COLUMNS = 'id, site_id, name, filters, value_expr, target, updated_at';
const SQL_LIST_GOALS = `SELECT ${GOAL_COLUMNS} FROM goals WHERE site_id = ? ORDER BY id`;
const SQL_GET_GOAL = `SELECT ${GOAL_COLUMNS} FROM goals WHERE id = ?`;
const SQL_CREATE_GOAL = `INSERT INTO goals
  (site_id, name, filters, value_expr, target, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`;
const SQL_UPDATE_GOAL = `UPDATE goals SET name = ?, filters = ?, value_expr = ?, target = ?,
  updated_at = ? WHERE id = ? RETURNING ${GOAL_COLUMNS}`;
const SQL_DELETE_GOAL = 'DELETE FROM goals WHERE id = ?';

export function listGoals(db: Db, siteId: number): GoalRow[] {
  return stmt<GoalRow>(db, SQL_LIST_GOALS).all(siteId) as GoalRow[];
}

export function getGoal(db: Db, id: number): GoalRow | undefined {
  return stmt<GoalRow>(db, SQL_GET_GOAL).get(id);
}

export type NewGoal = Omit<GoalRow, 'id' | 'updated_at'>;

export function createGoal(db: Db, goal: NewGoal, now: number): GoalRow {
  assertWritable(db);
  const info = stmt(db, SQL_CREATE_GOAL).run(
    goal.site_id,
    goal.name,
    goal.filters,
    goal.value_expr,
    goal.target,
    now,
    now,
  );
  return { id: Number(info.lastInsertRowid), ...goal, updated_at: now };
}

export function updateGoal(
  db: Db,
  id: number,
  patch: Omit<NewGoal, 'site_id'>,
  now: number,
): GoalRow | undefined {
  assertWritable(db);
  return stmt<GoalRow>(db, SQL_UPDATE_GOAL).get(
    patch.name,
    patch.filters,
    patch.value_expr,
    patch.target,
    now,
    id,
  );
}

export function deleteGoal(db: Db, id: number): boolean {
  assertWritable(db);
  return stmt(db, SQL_DELETE_GOAL).run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Admin sessions (docs/02 § Security posture)
// ---------------------------------------------------------------------------

export interface AdminSessionRow {
  id: string;
  created_at: number;
  expires_at: number;
  /** 'admin' | 'viewer' — resolved to a Principal by the auth gate. */
  principal_kind: string;
  viewer_id: number | null;
}

const SQL_INSERT_ADMIN_SESSION =
  'INSERT INTO admin_sessions (id, created_at, expires_at, principal_kind, viewer_id) VALUES (?, ?, ?, ?, ?)';
const SQL_GET_ADMIN_SESSION =
  'SELECT id, created_at, expires_at, principal_kind, viewer_id FROM admin_sessions WHERE id = ?';
const SQL_DELETE_ADMIN_SESSION = 'DELETE FROM admin_sessions WHERE id = ?';
const SQL_DELETE_ADMIN_SESSIONS_EXCEPT = 'DELETE FROM admin_sessions WHERE id <> ?';
const SQL_DELETE_EXPIRED_ADMIN_SESSIONS = 'DELETE FROM admin_sessions WHERE expires_at <= ?';

export function insertAdminSession(
  db: Db,
  row: Omit<AdminSessionRow, 'principal_kind' | 'viewer_id'> &
    Partial<Pick<AdminSessionRow, 'principal_kind' | 'viewer_id'>>,
): void {
  assertWritable(db);
  stmt(db, SQL_INSERT_ADMIN_SESSION).run(
    row.id,
    row.created_at,
    row.expires_at,
    row.principal_kind ?? 'admin',
    row.viewer_id ?? null,
  );
}

export function getAdminSession(db: Db, id: string): AdminSessionRow | undefined {
  return stmt<AdminSessionRow>(db, SQL_GET_ADMIN_SESSION).get(id);
}

/** Sliding renewal (viewer sessions): pushes `expires_at` forward, never back. */
export function extendAdminSession(db: Db, id: string, expiresAt: number): void {
  assertWritable(db);
  stmt(db, 'UPDATE admin_sessions SET expires_at = ? WHERE id = ? AND expires_at < ?').run(
    expiresAt,
    id,
    expiresAt,
  );
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

// ---------------------------------------------------------------------------
// API tokens & viewers (docs/04 § 5): scoped read-only principals
// ---------------------------------------------------------------------------

export interface ApiTokenRow {
  id: number;
  name: string;
  /** sha256 of the raw token — the raw value exists only in the mint response. */
  token_hash: Uint8Array;
  /** `'all'` or a JSON array of site ids; parseSiteScope validates on read. */
  site_scope: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const API_TOKEN_COLUMNS = 'id, name, token_hash, site_scope, created_at, last_used_at, revoked_at';
const SQL_INSERT_API_TOKEN =
  'INSERT INTO api_tokens (name, token_hash, site_scope, created_at) VALUES (?, ?, ?, ?)';
const SQL_GET_API_TOKEN = `SELECT ${API_TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?`;
const SQL_LIST_API_TOKENS = `SELECT ${API_TOKEN_COLUMNS} FROM api_tokens ORDER BY id`;
const SQL_REVOKE_API_TOKEN =
  'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL';
const SQL_TOUCH_API_TOKEN = 'UPDATE api_tokens SET last_used_at = ? WHERE id = ?';

export function insertApiToken(
  db: Db,
  row: Pick<ApiTokenRow, 'name' | 'token_hash' | 'site_scope' | 'created_at'>,
): number {
  assertWritable(db);
  const info = stmt(db, SQL_INSERT_API_TOKEN).run(
    row.name,
    row.token_hash,
    row.site_scope,
    row.created_at,
  );
  return Number(info.lastInsertRowid);
}

export function getApiTokenByHash(db: Db, tokenHash: Uint8Array): ApiTokenRow | undefined {
  return stmt<ApiTokenRow>(db, SQL_GET_API_TOKEN).get(tokenHash);
}

export function listApiTokens(db: Db): ApiTokenRow[] {
  return stmt<ApiTokenRow>(db, SQL_LIST_API_TOKENS).all() as ApiTokenRow[];
}

/** Revokes a live token; false if unknown or already revoked. */
export function revokeApiToken(db: Db, id: number, now: number): boolean {
  assertWritable(db);
  return stmt(db, SQL_REVOKE_API_TOKEN).run(now, id).changes > 0;
}

export function touchApiToken(db: Db, id: number, now: number): void {
  assertWritable(db);
  stmt(db, SQL_TOUCH_API_TOKEN).run(now, id);
}

export interface ViewerRow {
  id: number;
  email: string;
  site_scope: string;
  created_at: number;
  revoked_at: number | null;
}

const VIEWER_COLUMNS = 'id, email, site_scope, created_at, revoked_at';
const SQL_GET_VIEWER = `SELECT ${VIEWER_COLUMNS} FROM viewers WHERE id = ?`;
const SQL_GET_VIEWER_BY_EMAIL = `SELECT ${VIEWER_COLUMNS} FROM viewers WHERE email = ?`;
const SQL_LIST_VIEWERS = `SELECT ${VIEWER_COLUMNS} FROM viewers ORDER BY id`;
const SQL_INSERT_VIEWER = 'INSERT INTO viewers (email, site_scope, created_at) VALUES (?, ?, ?)';
// Re-inviting is a decision to restore access, so it clears any revocation.
const SQL_REINVITE_VIEWER = `UPDATE viewers SET site_scope = ?, revoked_at = NULL WHERE id = ? RETURNING ${VIEWER_COLUMNS}`;
const SQL_REVOKE_VIEWER = 'UPDATE viewers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL';

export function getViewer(db: Db, id: number): ViewerRow | undefined {
  return stmt<ViewerRow>(db, SQL_GET_VIEWER).get(id);
}

export function getViewerByEmail(db: Db, email: string): ViewerRow | undefined {
  return stmt<ViewerRow>(db, SQL_GET_VIEWER_BY_EMAIL).get(email);
}

export function listViewers(db: Db): ViewerRow[] {
  return stmt<ViewerRow>(db, SQL_LIST_VIEWERS).all() as ViewerRow[];
}

export function insertViewer(
  db: Db,
  row: Pick<ViewerRow, 'email' | 'site_scope' | 'created_at'>,
): ViewerRow {
  assertWritable(db);
  const info = stmt(db, SQL_INSERT_VIEWER).run(row.email, row.site_scope, row.created_at);
  return { id: Number(info.lastInsertRowid), ...row, revoked_at: null };
}

/** Re-invite: updates the scope and clears a revocation. Undefined if unknown. */
export function reinviteViewer(db: Db, id: number, siteScope: string): ViewerRow | undefined {
  assertWritable(db);
  return stmt<ViewerRow>(db, SQL_REINVITE_VIEWER).get(siteScope, id);
}

/** Revokes a live viewer; false if unknown or already revoked. */
export function revokeViewer(db: Db, id: number, now: number): boolean {
  assertWritable(db);
  return stmt(db, SQL_REVOKE_VIEWER).run(now, id).changes > 0;
}

export interface MagicLinkRow {
  /** sha256 of the raw link token — the raw value exists only in the mint response. */
  token_hash: Uint8Array;
  viewer_id: number;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

const MAGIC_LINK_COLUMNS = 'token_hash, viewer_id, created_at, expires_at, used_at';
const SQL_INSERT_MAGIC_LINK =
  'INSERT INTO magic_links (token_hash, viewer_id, created_at, expires_at) VALUES (?, ?, ?, ?)';
const SQL_GET_MAGIC_LINK = `SELECT ${MAGIC_LINK_COLUMNS} FROM magic_links WHERE token_hash = ?`;
// Single use: the UPDATE is the claim — `changes === 1` means WE consumed it,
// so two concurrent claims of one link cannot both win.
const SQL_CONSUME_MAGIC_LINK =
  'UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?';
const SQL_EXPIRE_VIEWER_MAGIC_LINKS =
  'UPDATE magic_links SET expires_at = ? WHERE viewer_id = ? AND used_at IS NULL AND expires_at > ?';
const SQL_PRUNE_MAGIC_LINKS =
  'DELETE FROM magic_links WHERE expires_at <= ? OR used_at IS NOT NULL';

export function insertMagicLink(db: Db, row: Omit<MagicLinkRow, 'used_at'>): void {
  assertWritable(db);
  stmt(db, SQL_INSERT_MAGIC_LINK).run(
    row.token_hash,
    row.viewer_id,
    row.created_at,
    row.expires_at,
  );
}

export function getMagicLink(db: Db, tokenHash: Uint8Array): MagicLinkRow | undefined {
  return stmt<MagicLinkRow>(db, SQL_GET_MAGIC_LINK).get(tokenHash);
}

/** Atomically consumes an unused, unexpired link; false = used, expired or unknown. */
export function consumeMagicLink(db: Db, tokenHash: Uint8Array, now: number): boolean {
  assertWritable(db);
  return stmt(db, SQL_CONSUME_MAGIC_LINK).run(now, tokenHash, now).changes > 0;
}

/** Expires every outstanding link of a viewer — the revocation companion. */
export function expireViewerMagicLinks(db: Db, viewerId: number, now: number): void {
  assertWritable(db);
  stmt(db, SQL_EXPIRE_VIEWER_MAGIC_LINKS).run(now, viewerId, now);
}

/** Drops expired and consumed links — opportunistic sweep, mirrors the session one. */
export function pruneMagicLinks(db: Db, now: number): void {
  assertWritable(db);
  stmt(db, SQL_PRUNE_MAGIC_LINKS).run(now);
}
