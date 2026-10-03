import {
  type HitType,
  isValidTimezone,
  MISSING_HITS_PER_SITE_DAY,
  SiteDomainsSchema,
} from '@featherstat/shared';
import BetterSqlite3 from 'better-sqlite3';
import { type Db, migrate } from './migrate.ts';

export {
  type Db,
  migrate,
  schemaVersion,
  V1_IMPORT_SUBCOMMAND,
} from './migrate.ts';

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
  /** The received referrer host, ONLY when canonicalization changed it (docs/03 § Attribution). */
  ref_domain_raw?: string | null;
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
  /** The hour `started_at` fell in, site-local — `local_date`'s grain partner. */
  local_hour: number;
  pageviews: number;
  events: number;
  engaged_ms: number;

  entry_path?: string | null;
  exit_path?: string | null;

  ref_domain?: string | null;
  ref_domain_raw?: string | null;
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
  ref_domain_raw: null,
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
  ref_domain_raw: null,
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

/**
 * Where every tool opens the database when `DB_PATH` is unset: the seeded dev
 * file, relative to the working directory. The image always sets `DB_PATH`.
 */
export const DEV_DB_PATH = 'data/dev.db';

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
 * How many `withWriteTransaction` bodies are running on each connection. The
 * connection's own `inTransaction` cannot tell a write transaction from a read
 * snapshot, so `assertWritable` asks this instead.
 */
const writeDepth = new WeakMap<Db, number>();

/**
 * The only way to write. Single-writer discipline (docs/02): the ingest batcher wraps
 * each 200 ms flush in one of these; everything else is a read. Nests safely (savepoints).
 */
export function withWriteTransaction<T>(db: Db, fn: () => T): T {
  const body = (): T => {
    writeDepth.set(db, (writeDepth.get(db) ?? 0) + 1);
    try {
      return fn();
    } finally {
      writeDepth.set(db, (writeDepth.get(db) ?? 1) - 1);
    }
  };
  const observers = writeObservers.get(db);
  if (observers === undefined || observers.size === 0 || db.inTransaction) {
    return db.transaction(body).immediate();
  }
  const started = performance.now();
  try {
    return db.transaction(body).immediate();
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

/** Throws unless a `withWriteTransaction` is open on `db` — a read snapshot does not count. */
export function assertWritable(db: Db): void {
  if ((writeDepth.get(db) ?? 0) === 0) {
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

// A tombstoned site is dead everywhere at once: these two accessors feed the
// directory, the query engine's scope resolution and the ingest pipeline, so
// excluding `deleted_at` here is what makes deletion take effect immediately —
// beacons drop exactly like an unknown site's, queries answer "unknown site".
// The purge job alone reads around the tombstone (jobs/site-purge.ts).
const SQL_LIST_SITES =
  'SELECT id, name, domains, timezone, created_at FROM sites WHERE deleted_at IS NULL ORDER BY id';
const SQL_GET_SITE =
  'SELECT id, name, domains, timezone, created_at FROM sites WHERE id = ? AND deleted_at IS NULL';
const SQL_CREATE_SITE =
  'INSERT INTO sites (id, name, domains, timezone, created_at) VALUES (?, ?, ?, ?, ?)';

const siteGenerations = new WeakMap<Db, number>();

/**
 * A counter every write helper below bumps when it changes `sites`, so an
 * in-memory copy (`pipeline/site-cache.ts`) knows it is stale without reading
 * the table. Keyed on the helpers rather than on the routes that call them, so
 * a new caller cannot forget it. Writes from another connection are the
 * cache's other half: `connectionDataVersion`.
 */
export function siteGeneration(db: Db): number {
  return siteGenerations.get(db) ?? 0;
}

function sitesChanged(db: Db): void {
  siteGenerations.set(db, siteGeneration(db) + 1);
}

/** SQLite's `PRAGMA data_version`: moves whenever ANOTHER connection commits to the file. */
export function connectionDataVersion(db: Db): number {
  return stmt<number>(db, 'PRAGMA data_version').pluck().get() as number;
}

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
  const timezone = checkedTimezone(site.timezone ?? DEFAULT_TIMEZONE);
  const created_at = site.created_at ?? Date.now();
  const info = stmt(db, SQL_CREATE_SITE).run(
    site.id ?? null,
    site.name,
    JSON.stringify(domains),
    timezone,
    created_at,
  );
  sitesChanged(db);
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
    timezone: checkedTimezone(patch.timezone ?? current.timezone),
  };
  const row = stmt<SiteColumns>(db, SQL_UPDATE_SITE).get(
    next.name,
    JSON.stringify(next.domains),
    next.timezone,
    id,
  );
  sitesChanged(db);
  return row === undefined ? undefined : decodeSite(row);
}

/**
 * The zod schemas refuse a bad zone at the HTTP boundary; this refuses it at
 * every other writer (the importers). A stored zone the runtime cannot resolve
 * degrades every local clock to UTC — silently, since ingest must not throw.
 */
function checkedTimezone(timezone: string): string {
  if (!isValidTimezone(timezone)) throw new Error(`not a usable timezone: '${timezone}'`);
  return timezone;
}

function decodeSite(row: SiteColumns): Site {
  return { ...row, domains: SiteDomainsSchema.parse(JSON.parse(row.domains)) };
}

const SQL_TOMBSTONE_SITE = 'UPDATE sites SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL';

/**
 * Marks a site deleted (docs/04 § 5). The row itself stays forever: `sites.id`
 * has no AUTOINCREMENT, so SQLite hands out `MAX(id) + 1` and a removed row
 * would let the next site inherit its id — and with it every grant, setting
 * and straggling row that still named the old one. False when the site is
 * unknown or already tombstoned.
 */
export function tombstoneSite(db: Db, id: number, now: number): boolean {
  assertWritable(db);
  const tombstoned = stmt(db, SQL_TOMBSTONE_SITE).run(now, id).changes > 0;
  if (tombstoned) sitesChanged(db);
  return tombstoned;
}

const SQL_TOMBSTONED_SITE_IDS = 'SELECT id FROM sites WHERE deleted_at IS NOT NULL';

/** Every tombstoned site id — the batcher's last gate for hits queued before a delete. */
export function tombstonedSiteIds(db: Db): Set<number> {
  return new Set(stmt<number>(db, SQL_TOMBSTONED_SITE_IDS).pluck().all());
}

/** The small per-site config tables the delete route clears inline — one short
 * transaction, unlike the bulk data the chunked purge job owns. Dashboards and
 * alert rules are NOT here: those need their own delete paths (share-token
 * revocation, the settings-row rewrite), which the route drives. */
const SITE_CONFIG_TABLES = [
  'goals',
  'campaigns',
  'campaign_aliases',
  'prop_keys',
  'prop_values',
  'prop_drops',
] as const;

export function deleteSiteConfigRows(db: Db, siteId: number): void {
  assertWritable(db);
  for (const table of SITE_CONFIG_TABLES) {
    stmt(db, `DELETE FROM ${table} WHERE site_id = ?`).run(siteId);
  }
}

const SQL_DELETE_SITE_ANNOTATIONS = 'DELETE FROM annotations WHERE site_id = ?';

/** Removes one site's annotations (install-wide NULL-site rows stay); returns how many. */
export function deleteSiteAnnotations(db: Db, siteId: number): number {
  assertWritable(db);
  return stmt(db, SQL_DELETE_SITE_ANNOTATIONS).run(siteId).changes;
}

// ---------------------------------------------------------------------------
// Events & sessions (batcher-owned)
// ---------------------------------------------------------------------------

const SQL_INSERT_EVENT = `INSERT INTO events (
  site_id, ts, local_date, local_hour, type, visitor_id, session_id, seq,
  hostname, path, title, target_url,
  ref_domain, ref_domain_raw, ref_type, utm_source, utm_medium, utm_campaign,
  utm_source_raw, utm_medium_raw, utm_campaign_raw,
  event_category, event_action, event_name, event_value,
  browser, browser_version, os, device_type, screen, lang,
  country, region, city, lat, lon, scroll_pct, props
) VALUES (
  @site_id, @ts, @local_date, @local_hour, @type, @visitor_id, @session_id, @seq,
  @hostname, @path, @title, @target_url,
  @ref_domain, @ref_domain_raw, @ref_type, @utm_source, @utm_medium, @utm_campaign,
  @utm_source_raw, @utm_medium_raw, @utm_campaign_raw,
  @event_category, @event_action, @event_name, @event_value,
  @browser, @browser_version, @os, @device_type, @screen, @lang,
  @country, @region, @city, @lat, @lon, @scroll_pct, @props
)`;

/** Counters and exit state are re-sent in full by the sessionizer; first-touch columns stick. */
const SQL_UPSERT_SESSION = `INSERT INTO sessions (
  id, site_id, visitor_id, started_at, last_seen_at, local_date, local_hour,
  entry_path, exit_path, pageviews, events, engaged_ms,
  ref_domain, ref_domain_raw, ref_type, utm_source, utm_medium, utm_campaign,
  utm_source_raw, utm_medium_raw, utm_campaign_raw,
  browser, os, device_type, country, region, city
) VALUES (
  @id, @site_id, @visitor_id, @started_at, @last_seen_at, @local_date, @local_hour,
  @entry_path, @exit_path, @pageviews, @events, @engaged_ms,
  @ref_domain, @ref_domain_raw, @ref_type, @utm_source, @utm_medium, @utm_campaign,
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

const SQL_DATA_VERSION = `SELECT COALESCE((SELECT MAX(id) FROM events), 0)
  + COALESCE((SELECT MAX(id) FROM missing_hits), 0)`;

/**
 * Insert-only history moves MAX(events.id), and a not-found hit moves
 * MAX(missing_hits.id) — the sum grows whenever either table does. In-place
 * rewrites (alias backfill, prop scrub, site purge, rollup rebuild) do not, so
 * each of those bumps the epoch instead — otherwise every ETag computed before
 * the rewrite would keep answering 304 forever. 2^40 rowids per epoch keeps the
 * combined value well inside Number.MAX_SAFE_INTEGER for any plausible bump
 * count.
 */
const EPOCH_SETTING = 'data_epoch';
const EPOCH_STRIDE = 2 ** 40;

/** Epoch-stridden sum of the two tables' MAX(id): the data version for ETags (docs/03). */
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
  return stmt<SessionRow & { max_seq: number }>(db, SQL_OPEN_SESSIONS).all(since);
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
  );
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
  return stmt<string>(db, SQL_SETTING_KEYS).pluck().all(`${escaped}%`);
}

export function setSetting(db: Db, key: string, value: string): void {
  assertWritable(db);
  stmt(db, SQL_SET_SETTING).run(key, value);
}

export function deleteSetting(db: Db, key: string): void {
  assertWritable(db);
  stmt(db, SQL_DELETE_SETTING).run(key);
}

export interface DropCountRow {
  site_id: number;
  local_date: string;
  count: number;
}

/**
 * The per-site/per-day drop counters share a shape: a hit refused at the door is
 * counted, never stored. `bot_drops` and `excluded_drops` are separate tables so
 * a reader can tell "a crawler" from "the operator" without a discriminator
 * column, but the three accessors are identical, so they are built once.
 */
function dropCounters(table: string) {
  const incrementSql = `INSERT INTO ${table} (site_id, local_date, count) VALUES (?, ?, ?)
ON CONFLICT (site_id, local_date) DO UPDATE SET count = count + excluded.count`;
  const getSql = `SELECT count FROM ${table} WHERE site_id = ? AND local_date = ?`;
  const listSql = `SELECT site_id, local_date, count FROM ${table} WHERE local_date >= ? ORDER BY local_date DESC, site_id`;
  return {
    increment(db: Db, siteId: number, localDate: string, count = 1): void {
      assertWritable(db);
      stmt(db, incrementSql).run(siteId, localDate, count);
    },
    get(db: Db, siteId: number, localDate: string): number {
      return stmt<{ count: number }>(db, getSql).get(siteId, localDate)?.count ?? 0;
    },
    /** Diagnostics (docs/04 § 5): per-site counters since a local date (inclusive). */
    list(db: Db, sinceLocalDate: string): DropCountRow[] {
      return stmt<DropCountRow>(db, listSql).all(sinceLocalDate);
    },
  };
}

const botDropCounters = dropCounters('bot_drops');
const excludedDropCounters = dropCounters('excluded_drops');

export const incrementBotDrops = botDropCounters.increment;
export const getBotDrops = botDropCounters.get;
export const listBotDrops = botDropCounters.list;

export const incrementExcludedDrops = excludedDropCounters.increment;
export const getExcludedDrops = excludedDropCounters.get;
export const listExcludedDrops = excludedDropCounters.list;

// ---------------------------------------------------------------------------
// Not-found hits (docs/03 § Not-found hits)
// ---------------------------------------------------------------------------

/** One not-found hit: what finds the broken link, and nothing that identifies a visitor. */
export interface MissingRow {
  site_id: number;
  ts: number;
  local_date: string;
  local_hour: number;
  /** The path asked for; null when the page did not say. */
  path: string | null;
  ref_type: 'direct' | 'search' | 'social' | 'referral' | 'internal';
  ref_domain: string | null;
  /** The referring page's pathname, query dropped. */
  ref_path: string | null;
  device_type: string | null;
  country: string | null;
}

const SQL_COUNT_MISSING = `INSERT INTO missing_daily (site_id, local_date, count) VALUES (?, ?, 1)
ON CONFLICT (site_id, local_date) DO UPDATE SET count = count + 1
RETURNING count`;
const SQL_INSERT_MISSING = `INSERT INTO missing_hits
  (site_id, ts, local_date, local_hour, path, ref_type, ref_domain, ref_path, device_type, country)
VALUES
  (@site_id, @ts, @local_date, @local_hour, @path, @ref_type, @ref_domain, @ref_path,
   @device_type, @country)`;

/**
 * Counts every row and stores those under the per-site daily cap: a scanner
 * sweeping hundreds of paths is a number, not hundreds of rows.
 */
export function insertMissingHits(db: Db, rows: readonly MissingRow[]): void {
  assertWritable(db);
  const count = stmt(db, SQL_COUNT_MISSING).pluck();
  const insert = stmt(db, SQL_INSERT_MISSING);
  for (const row of rows) {
    if ((count.get(row.site_id, row.local_date) as number) <= MISSING_HITS_PER_SITE_DAY) {
      insert.run(row);
    }
  }
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
  return stmt<PropKeyRow>(db, SQL_LIST_PROP_KEYS).all(siteId);
}

export interface PropDropRow {
  local_date: string;
  reason: string;
  count: number;
}

const SQL_LIST_PROP_DROPS = `SELECT local_date, reason, count FROM prop_drops
WHERE site_id = ? AND local_date >= ? ORDER BY local_date DESC, reason`;

export function listPropDrops(db: Db, siteId: number, sinceLocalDate: string): PropDropRow[] {
  return stmt<PropDropRow>(db, SQL_LIST_PROP_DROPS).all(siteId, sinceLocalDate);
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
  /** Shipped-template id this row was cloned from — the reset target; NULL otherwise. */
  template: string | null;
  /** Manual library ordering (docs/05 § The dashboard library); 0 = creation order. */
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/** What a create supplies; `created_at` starts at `updated_at` and `sort_order` at 0. */
export type NewDashboard = Omit<DashboardRow, 'id' | 'created_at' | 'sort_order'>;

/** A list row also counts its LIVE share links — the delete confirm says what a delete revokes. */
export interface DashboardListRow extends DashboardRow {
  share_count: number;
}

const DASHBOARD_COLUMNS =
  'id, name, site_scope, layout, template, sort_order, created_at, updated_at';
const SQL_LIST_DASHBOARDS = `SELECT ${DASHBOARD_COLUMNS},
  (SELECT COUNT(*) FROM share_tokens st
   WHERE st.dashboard_id = dashboards.id AND st.revoked_at IS NULL) AS share_count
FROM dashboards ORDER BY id`;
const SQL_GET_DASHBOARD = `SELECT ${DASHBOARD_COLUMNS} FROM dashboards WHERE id = ?`;
const SQL_CREATE_DASHBOARD = `INSERT INTO dashboards (name, site_scope, layout, template, updated_at, created_at)
VALUES (?, ?, ?, ?, ?, ?)`;
const SQL_UPDATE_DASHBOARD = `UPDATE dashboards SET name = ?, site_scope = ?, layout = ?, updated_at = ?
WHERE id = ? RETURNING ${DASHBOARD_COLUMNS}`;
const SQL_DELETE_DASHBOARD = 'DELETE FROM dashboards WHERE id = ?';
const SQL_DELETE_DASHBOARD_TOKENS = 'DELETE FROM share_tokens WHERE dashboard_id = ?';
const SQL_COUNT_LIVE_SHARE_TOKENS =
  'SELECT COUNT(*) FROM share_tokens WHERE dashboard_id = ? AND revoked_at IS NULL';

export function listDashboards(db: Db): DashboardListRow[] {
  return stmt<DashboardListRow>(db, SQL_LIST_DASHBOARDS).all();
}

export function getDashboard(db: Db, id: number): DashboardRow | undefined {
  return stmt<DashboardRow>(db, SQL_GET_DASHBOARD).get(id);
}

export function countLiveShareTokens(db: Db, dashboardId: number): number {
  return stmt(db, SQL_COUNT_LIVE_SHARE_TOKENS).pluck().get(dashboardId) as number;
}

export function createDashboard(db: Db, row: NewDashboard): DashboardRow {
  assertWritable(db);
  const info = stmt(db, SQL_CREATE_DASHBOARD).run(
    row.name,
    row.site_scope,
    row.layout,
    row.template,
    row.updated_at,
    row.updated_at, // created_at: a fresh row's clocks start together
  );
  return { id: Number(info.lastInsertRowid), sort_order: 0, created_at: row.updated_at, ...row };
}

/** Rewrites the layout and its denormalized fields; `template`/`sort_order`/`created_at` stay. */
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
  return stmt<SegmentRow>(db, SQL_LIST_SEGMENTS).all();
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
const SQL_GET_DERIVED_BY_NAME = `SELECT ${DERIVED_COLUMNS} FROM derived_metrics WHERE name = ?`;
const SQL_CREATE_DERIVED =
  'INSERT INTO derived_metrics (name, expr, created_at, updated_at) VALUES (?, ?, ?, ?)';
const SQL_UPDATE_DERIVED = `UPDATE derived_metrics SET name = ?, expr = ?, updated_at = ?
WHERE id = ? RETURNING ${DERIVED_COLUMNS}`;
const SQL_DELETE_DERIVED = 'DELETE FROM derived_metrics WHERE id = ?';

export function listDerivedMetrics(db: Db): DerivedMetricRow[] {
  return stmt<DerivedMetricRow>(db, SQL_LIST_DERIVED).all();
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
  return stmt<CampaignAliasRow>(db, SQL_ALL_CAMPAIGN_ALIASES).all();
}

/** One site's alias rows (site 0 = install-wide). */
export function listCampaignAliases(db: Db, siteId: number): CampaignAliasRow[] {
  return stmt<CampaignAliasRow>(db, SQL_LIST_CAMPAIGN_ALIASES).all(siteId);
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

// The campaigns registry is read at QUERY time (`campaign_status`,
// query/compiler.ts), so an edit changes answers without moving `dataVersion`.
// Every registry write bumps `campaigns_version` in its own transaction, and
// requests that use the dimension hash it into their ETag (routes/etag.ts).
const CAMPAIGNS_VERSION_SETTING = 'campaigns_version';

export function campaignsVersion(db: Db): number {
  return Number(getSetting(db, CAMPAIGNS_VERSION_SETTING) ?? 0);
}

function bumpCampaignsVersion(db: Db): void {
  setSetting(db, CAMPAIGNS_VERSION_SETTING, String(campaignsVersion(db) + 1));
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
  return stmt<CampaignRow>(db, SQL_LIST_CAMPAIGNS).all(siteId);
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
  bumpCampaignsVersion(db);
  return { id: Number(info.lastInsertRowid), ...row };
}

export function updateCampaign(
  db: Db,
  id: number,
  patch: Omit<NewCampaign, 'site_id' | 'created_at'>,
): CampaignRow | undefined {
  assertWritable(db);
  const row = stmt<CampaignRow>(db, SQL_UPDATE_CAMPAIGN).get(
    patch.name,
    patch.expected_sources,
    patch.expected_mediums,
    patch.starts_at,
    patch.ends_at,
    patch.notes,
    id,
  );
  if (row !== undefined) bumpCampaignsVersion(db);
  return row;
}

export function deleteCampaign(db: Db, id: number): boolean {
  assertWritable(db);
  const deleted = stmt(db, SQL_DELETE_CAMPAIGN).run(id).changes > 0;
  if (deleted) bumpCampaignsVersion(db);
  return deleted;
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
  return stmt<GoalRow>(db, SQL_LIST_GOALS).all(siteId);
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
// Annotations (docs/04 § 3, § 5): operator notes pinned to a moment. Writes
// bump `annotations_version` — its own counter, NOT `data_epoch`, because an
// annotation edit changes no data and only requests that opted into
// `meta.annotations` hash it into their ETag (routes/query.ts).
// ---------------------------------------------------------------------------

export interface AnnotationRow {
  id: number;
  /** NULL = every site. */
  site_id: number | null;
  ts: number;
  text: string;
  updated_at: number;
}

const ANNOTATION_COLUMNS = 'id, site_id, ts, text, updated_at';
const SQL_LIST_ANNOTATIONS = `SELECT ${ANNOTATION_COLUMNS} FROM annotations ORDER BY ts, id`;
const SQL_LIST_SITE_ANNOTATIONS = `SELECT ${ANNOTATION_COLUMNS} FROM annotations
WHERE site_id = ? OR site_id IS NULL ORDER BY ts, id`;
const SQL_CREATE_ANNOTATION =
  'INSERT INTO annotations (site_id, ts, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)';
const SQL_UPDATE_ANNOTATION = `UPDATE annotations SET site_id = ?, ts = ?, text = ?, updated_at = ?
WHERE id = ? RETURNING ${ANNOTATION_COLUMNS}`;
const SQL_DELETE_ANNOTATION = 'DELETE FROM annotations WHERE id = ?';

export function getAnnotation(db: Db, id: number): AnnotationRow | undefined {
  return stmt<AnnotationRow>(db, `SELECT ${ANNOTATION_COLUMNS} FROM annotations WHERE id = ?`).get(
    id,
  );
}

/** All annotations, or one site's plus the install-wide (NULL-site) ones. */
export function listAnnotations(db: Db, siteId?: number): AnnotationRow[] {
  if (siteId === undefined) {
    return stmt<AnnotationRow>(db, SQL_LIST_ANNOTATIONS).all();
  }
  return stmt<AnnotationRow>(db, SQL_LIST_SITE_ANNOTATIONS).all(siteId);
}

export function createAnnotation(
  db: Db,
  siteId: number | null,
  ts: number,
  text: string,
  now: number,
): AnnotationRow {
  assertWritable(db);
  const info = stmt(db, SQL_CREATE_ANNOTATION).run(siteId, ts, text, now, now);
  return { id: Number(info.lastInsertRowid), site_id: siteId, ts, text, updated_at: now };
}

export function updateAnnotation(
  db: Db,
  id: number,
  siteId: number | null,
  ts: number,
  text: string,
  now: number,
): AnnotationRow | undefined {
  assertWritable(db);
  return stmt<AnnotationRow>(db, SQL_UPDATE_ANNOTATION).get(siteId, ts, text, now, id);
}

export function deleteAnnotation(db: Db, id: number): boolean {
  assertWritable(db);
  return stmt(db, SQL_DELETE_ANNOTATION).run(id).changes > 0;
}

const ANNOTATIONS_VERSION_SETTING = 'annotations_version';

/** Monotonic counter the ETag hashes for annotation-opted requests. */
export function annotationsVersion(db: Db): number {
  return Number(getSetting(db, ANNOTATIONS_VERSION_SETTING) ?? 0);
}

/** Every annotation write calls this once, inside its own transaction. */
export function bumpAnnotationsVersion(db: Db): void {
  setSetting(db, ANNOTATIONS_VERSION_SETTING, String(annotationsVersion(db) + 1));
}

// ---------------------------------------------------------------------------
// Admin sessions (docs/02 § Security posture)
// ---------------------------------------------------------------------------

export interface AdminSessionRow {
  id: string;
  created_at: number;
  expires_at: number;
  /** 'admin' | 'viewer' | 'user' — resolved to a Principal by the auth gate. */
  principal_kind: string;
  viewer_id: number | null;
  user_id: number | null;
}

const SQL_INSERT_ADMIN_SESSION =
  'INSERT INTO admin_sessions (id, created_at, expires_at, principal_kind, viewer_id, user_id) VALUES (?, ?, ?, ?, ?, ?)';
const SQL_GET_ADMIN_SESSION =
  'SELECT id, created_at, expires_at, principal_kind, viewer_id, user_id FROM admin_sessions WHERE id = ?';
const SQL_DELETE_ADMIN_SESSION = 'DELETE FROM admin_sessions WHERE id = ?';
const SQL_DELETE_ADMIN_SESSIONS_EXCEPT =
  "DELETE FROM admin_sessions WHERE principal_kind = 'admin' AND id <> ?";
const SQL_DELETE_EXPIRED_ADMIN_SESSIONS = 'DELETE FROM admin_sessions WHERE expires_at <= ?';

export function insertAdminSession(
  db: Db,
  row: Omit<AdminSessionRow, 'principal_kind' | 'viewer_id' | 'user_id'> &
    Partial<Pick<AdminSessionRow, 'principal_kind' | 'viewer_id' | 'user_id'>>,
): void {
  assertWritable(db);
  stmt(db, SQL_INSERT_ADMIN_SESSION).run(
    row.id,
    row.created_at,
    row.expires_at,
    row.principal_kind ?? 'admin',
    row.viewer_id ?? null,
    row.user_id ?? null,
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

/** Admin password change: the admin's other devices are logged out; the
 * changing session stays. User and viewer sessions are not the admin's devices. */
export function deleteAdminSessionsExcept(db: Db, keepId: string): void {
  assertWritable(db);
  stmt(db, SQL_DELETE_ADMIN_SESSIONS_EXCEPT).run(keepId);
}

export function deleteExpiredAdminSessions(db: Db, now: number): void {
  assertWritable(db);
  stmt(db, SQL_DELETE_EXPIRED_ADMIN_SESSIONS).run(now);
}

/** Logs a user out everywhere; `keepId` (their own password-change session) survives. */
export function deleteUserSessions(db: Db, userId: number, keepId?: string): void {
  assertWritable(db);
  stmt(db, 'DELETE FROM admin_sessions WHERE user_id = ? AND id <> ?').run(userId, keepId ?? '');
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
  /** Minting user, or NULL for an admin mint. Bounds who may list/revoke it. */
  created_by_user_id: number | null;
}

const API_TOKEN_COLUMNS =
  'id, name, token_hash, site_scope, created_at, last_used_at, revoked_at, created_by_user_id';
const SQL_INSERT_API_TOKEN =
  'INSERT INTO api_tokens (name, token_hash, site_scope, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?)';
const SQL_GET_API_TOKEN = `SELECT ${API_TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?`;
const SQL_GET_API_TOKEN_BY_ID = `SELECT ${API_TOKEN_COLUMNS} FROM api_tokens WHERE id = ?`;
const SQL_LIST_API_TOKENS = `SELECT ${API_TOKEN_COLUMNS} FROM api_tokens ORDER BY id`;
const SQL_REVOKE_API_TOKEN =
  'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL';
const SQL_TOUCH_API_TOKEN = 'UPDATE api_tokens SET last_used_at = ? WHERE id = ?';
const SQL_SET_API_TOKEN_SCOPE = 'UPDATE api_tokens SET site_scope = ? WHERE id = ?';

export function insertApiToken(
  db: Db,
  row: Pick<ApiTokenRow, 'name' | 'token_hash' | 'site_scope' | 'created_at'> &
    Partial<Pick<ApiTokenRow, 'created_by_user_id'>>,
): number {
  assertWritable(db);
  const info = stmt(db, SQL_INSERT_API_TOKEN).run(
    row.name,
    row.token_hash,
    row.site_scope,
    row.created_at,
    row.created_by_user_id ?? null,
  );
  return Number(info.lastInsertRowid);
}

export function getApiTokenByHash(db: Db, tokenHash: Uint8Array): ApiTokenRow | undefined {
  return stmt<ApiTokenRow>(db, SQL_GET_API_TOKEN).get(tokenHash);
}

export function getApiToken(db: Db, id: number): ApiTokenRow | undefined {
  return stmt<ApiTokenRow>(db, SQL_GET_API_TOKEN_BY_ID).get(id);
}

export function listApiTokens(db: Db): ApiTokenRow[] {
  return stmt<ApiTokenRow>(db, SQL_LIST_API_TOKENS).all();
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

/** Narrows a token's scope in place (auth/grants.ts); minting never widens one. */
export function setApiTokenScope(db: Db, id: number, siteScope: string): void {
  assertWritable(db);
  stmt(db, SQL_SET_API_TOKEN_SCOPE).run(siteScope, id);
}

export interface ViewerRow {
  id: number;
  email: string;
  site_scope: string;
  created_at: number;
  revoked_at: number | null;
  /** Inviting user, or NULL for an admin invite. Bounds who may list/revoke it. */
  created_by_user_id: number | null;
}

const VIEWER_COLUMNS = 'id, email, site_scope, created_at, revoked_at, created_by_user_id';
const SQL_GET_VIEWER = `SELECT ${VIEWER_COLUMNS} FROM viewers WHERE id = ?`;
const SQL_GET_VIEWER_BY_EMAIL = `SELECT ${VIEWER_COLUMNS} FROM viewers WHERE email = ?`;
const SQL_LIST_VIEWERS = `SELECT ${VIEWER_COLUMNS} FROM viewers ORDER BY id`;
const SQL_INSERT_VIEWER =
  'INSERT INTO viewers (email, site_scope, created_at, created_by_user_id) VALUES (?, ?, ?, ?)';
// Re-inviting is a decision to restore access, so it clears any revocation.
const SQL_REINVITE_VIEWER = `UPDATE viewers SET site_scope = ?, revoked_at = NULL WHERE id = ? RETURNING ${VIEWER_COLUMNS}`;
const SQL_REVOKE_VIEWER = 'UPDATE viewers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL';
const SQL_SET_VIEWER_SCOPE = 'UPDATE viewers SET site_scope = ? WHERE id = ?';

export function getViewer(db: Db, id: number): ViewerRow | undefined {
  return stmt<ViewerRow>(db, SQL_GET_VIEWER).get(id);
}

export function getViewerByEmail(db: Db, email: string): ViewerRow | undefined {
  return stmt<ViewerRow>(db, SQL_GET_VIEWER_BY_EMAIL).get(email);
}

export function listViewers(db: Db): ViewerRow[] {
  return stmt<ViewerRow>(db, SQL_LIST_VIEWERS).all();
}

export function insertViewer(
  db: Db,
  row: Pick<ViewerRow, 'email' | 'site_scope' | 'created_at'> &
    Partial<Pick<ViewerRow, 'created_by_user_id'>>,
): ViewerRow {
  assertWritable(db);
  const createdBy = row.created_by_user_id ?? null;
  const info = stmt(db, SQL_INSERT_VIEWER).run(
    row.email,
    row.site_scope,
    row.created_at,
    createdBy,
  );
  return {
    id: Number(info.lastInsertRowid),
    email: row.email,
    site_scope: row.site_scope,
    created_at: row.created_at,
    revoked_at: null,
    created_by_user_id: createdBy,
  };
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

/** Narrows a viewer's scope in place (auth/grants.ts), leaving any revocation as it is. */
export function setViewerScope(db: Db, id: number, siteScope: string): void {
  assertWritable(db);
  stmt(db, SQL_SET_VIEWER_SCOPE).run(siteScope, id);
}

export interface MagicLinkRow {
  /** sha256 of the raw link token — the raw value exists only in the mint response. */
  token_hash: Uint8Array;
  /** Exactly one of viewer_id / user_id is set (schema CHECK). */
  viewer_id: number | null;
  user_id: number | null;
  /** 'viewer-login' | 'user-invite' — what claiming the link does. */
  purpose: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

const MAGIC_LINK_COLUMNS =
  'token_hash, viewer_id, user_id, purpose, created_at, expires_at, used_at';
const SQL_INSERT_MAGIC_LINK =
  'INSERT INTO magic_links (token_hash, viewer_id, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)';
const SQL_GET_MAGIC_LINK = `SELECT ${MAGIC_LINK_COLUMNS} FROM magic_links WHERE token_hash = ?`;
// Single use: the UPDATE is the claim — `changes === 1` means WE consumed it,
// so two concurrent claims of one link cannot both win.
const SQL_CONSUME_MAGIC_LINK =
  'UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?';
const SQL_EXPIRE_VIEWER_MAGIC_LINKS =
  'UPDATE magic_links SET expires_at = ? WHERE viewer_id = ? AND used_at IS NULL AND expires_at > ?';
const SQL_EXPIRE_USER_MAGIC_LINKS =
  'UPDATE magic_links SET expires_at = ? WHERE user_id = ? AND used_at IS NULL AND expires_at > ?';
const SQL_PRUNE_MAGIC_LINKS =
  'DELETE FROM magic_links WHERE expires_at <= ? OR used_at IS NOT NULL';

export function insertMagicLink(db: Db, row: Omit<MagicLinkRow, 'used_at'>): void {
  assertWritable(db);
  stmt(db, SQL_INSERT_MAGIC_LINK).run(
    row.token_hash,
    row.viewer_id,
    row.user_id,
    row.purpose,
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

/** Expires every outstanding invite of a user — the disable companion. */
export function expireUserMagicLinks(db: Db, userId: number, now: number): void {
  assertWritable(db);
  stmt(db, SQL_EXPIRE_USER_MAGIC_LINKS).run(now, userId, now);
}

/** Drops expired and consumed links — opportunistic sweep, mirrors the session one. */
export function pruneMagicLinks(db: Db, now: number): void {
  assertWritable(db);
  stmt(db, SQL_PRUNE_MAGIC_LINKS).run(now);
}

// ---------------------------------------------------------------------------
// Users (docs/04 § 5): password-holding accounts that own and manage sites.
// The instance admin is not here — it stays the `auth.password` settings row.
// ---------------------------------------------------------------------------

export interface UserRow {
  id: number;
  email: string;
  /** scrypt string, or NULL while the invite is unclaimed (login refuses NULL). */
  password_hash: string | null;
  created_at: number;
  disabled_at: number | null;
}

const USER_COLUMNS = 'id, email, password_hash, created_at, disabled_at';
const SQL_GET_USER = `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`;
const SQL_GET_USER_BY_EMAIL = `SELECT ${USER_COLUMNS} FROM users WHERE email = ?`;
const SQL_LIST_USERS = `SELECT ${USER_COLUMNS} FROM users ORDER BY id`;
const SQL_INSERT_USER = 'INSERT INTO users (email, created_at) VALUES (?, ?)';
const SQL_SET_USER_PASSWORD = 'UPDATE users SET password_hash = ? WHERE id = ?';
const SQL_DISABLE_USER = 'UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL';
const SQL_ENABLE_USER = 'UPDATE users SET disabled_at = NULL WHERE id = ?';

export function getUser(db: Db, id: number): UserRow | undefined {
  return stmt<UserRow>(db, SQL_GET_USER).get(id);
}

/** Case-insensitive: the email column collates NOCASE. */
export function getUserByEmail(db: Db, email: string): UserRow | undefined {
  return stmt<UserRow>(db, SQL_GET_USER_BY_EMAIL).get(email);
}

export function listUsers(db: Db): UserRow[] {
  return stmt<UserRow>(db, SQL_LIST_USERS).all();
}

export function insertUser(db: Db, email: string, now: number): UserRow {
  assertWritable(db);
  const info = stmt(db, SQL_INSERT_USER).run(email, now);
  return {
    id: Number(info.lastInsertRowid),
    email,
    password_hash: null,
    created_at: now,
    disabled_at: null,
  };
}

export function setUserPassword(db: Db, id: number, passwordHash: string): void {
  assertWritable(db);
  stmt(db, SQL_SET_USER_PASSWORD).run(passwordHash, id);
}

/** Soft revoke; false if unknown or already disabled. Live sessions die at the gate. */
export function disableUser(db: Db, id: number, now: number): boolean {
  assertWritable(db);
  return stmt(db, SQL_DISABLE_USER).run(now, id).changes > 0;
}

/** Re-invite restores access, exactly as it does for viewers. */
export function enableUser(db: Db, id: number): void {
  assertWritable(db);
  stmt(db, SQL_ENABLE_USER).run(id);
}

const SQL_LIST_USER_SITES = 'SELECT site_id FROM user_sites WHERE user_id = ? ORDER BY site_id';
const SQL_ADD_USER_SITE = 'INSERT OR IGNORE INTO user_sites (user_id, site_id) VALUES (?, ?)';
const SQL_CLEAR_USER_SITES = 'DELETE FROM user_sites WHERE user_id = ?';
const SQL_REMOVE_SITE_FROM_USERS = 'DELETE FROM user_sites WHERE site_id = ?';

export function listUserSites(db: Db, userId: number): number[] {
  return stmt<{ site_id: number }>(db, SQL_LIST_USER_SITES)
    .all(userId)
    .map((row) => row.site_id);
}

/** Ownership grows on site create: one row, in the creating transaction. */
export function addUserSite(db: Db, userId: number, siteId: number): void {
  assertWritable(db);
  stmt(db, SQL_ADD_USER_SITE).run(userId, siteId);
}

/** Admin reassignment: replaces the user's whole set. */
export function setUserSites(db: Db, userId: number, siteIds: readonly number[]): void {
  assertWritable(db);
  stmt(db, SQL_CLEAR_USER_SITES).run(userId);
  for (const siteId of siteIds) stmt(db, SQL_ADD_USER_SITE).run(userId, siteId);
}

/** Site deletion companion: no user owns a tombstoned site. */
export function removeSiteFromUsers(db: Db, siteId: number): void {
  assertWritable(db);
  stmt(db, SQL_REMOVE_SITE_FROM_USERS).run(siteId);
}
