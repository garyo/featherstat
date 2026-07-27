import {
  createSite,
  type Db,
  type EventRow,
  getSetting,
  insertEvents,
  listSites,
  type NewSite,
  type SessionRow,
  setSetting,
  stmt,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import {
  type MatomoActionRow,
  type MatomoSiteRow,
  type MatomoVisitRow,
  mapAction,
  mapSite,
  mapVisit,
  sessionIdForVisit,
} from './mappers.ts';

/**
 * Streams the three Matomo tables in id order through the pure mappers into
 * the local database (docs/06). The MySQL side is an injected query function,
 * so the whole importer is testable without a live server; the CLI (cli.ts)
 * supplies the real mysql2 connection.
 *
 * Idempotency: a high-water mark per source table lives in `settings`
 * (`import:matomo:<table>`) and advances inside the same transaction as each
 * batch's rows — re-running tops up, never duplicates. Sessions additionally
 * get deterministic ids from `idvisit`, so a re-imported visit upserts in place.
 */

export type SourceQuery = (
  sql: string,
  params: readonly unknown[],
) => Promise<Array<Record<string, unknown>>>;

export interface ImportOptions {
  /** Map + count + report, write nothing (validation gate aid, docs/06). */
  dryRun?: boolean;
  /**
   * 'YYYY-MM-DD': only visits/actions at or after this UTC date (the final
   * top-up). Visits in the window are re-read regardless of the watermark, so
   * rows Matomo mutated in place since the last run (a visit straddling an
   * import accrues more actions) upsert to their final state.
   */
  since?: string;
  /**
   * 'YYYY-MM-DD': only visits/actions strictly BEFORE this UTC date. At
   * cutover this is the tee-start date — everything from then on was already
   * ingested live, and importing it again would double-count (docs/06).
   */
  until?: string;
  batchSize?: number;
  /** Per-batch progress lines. */
  log?: (line: string) => void;
}

export interface DayTotal {
  site_id: number;
  local_date: string;
  visits: number;
  pageviews: number;
}

export interface ImportReport {
  dryRun: boolean;
  sites: number;
  /** Sites already present locally (ids preserved, so a re-run skips them). */
  sitesSkipped: number;
  sessions: number;
  events: number;
  /** Rows outside our model (site search, ecommerce…) or unmappable/unknown-site. */
  skipped: number;
  /** Per-site/day visit + pageview totals for everything scanned this run. */
  days: DayTotal[];
}

const DEFAULT_BATCH_SIZE = 1000;
const WATERMARK_PREFIX = 'import:matomo:';

const SQL_SITES = `SELECT idsite, name, main_url, ts_created, timezone
FROM matomo_site
WHERE idsite > ?
ORDER BY idsite
LIMIT ?`;

const SQL_SITE_URLS = 'SELECT idsite, url FROM matomo_site_url WHERE idsite IN (?)';

function visitsSql(since: boolean, until: boolean): string {
  return `SELECT v.idvisit, v.idsite, v.idvisitor,
  v.visit_first_action_time, v.visit_last_action_time,
  v.visit_total_time, v.visit_total_actions, v.visit_total_events,
  v.referer_type, v.referer_name, v.referer_url,
  v.campaign_name, v.campaign_source, v.campaign_medium,
  v.config_browser_name, v.config_browser_version, v.config_os,
  v.config_device_type, v.config_resolution,
  v.location_browser_lang, v.location_country, v.location_region, v.location_city,
  v.location_latitude, v.location_longitude,
  entry_action.name AS entry_url_name, entry_action.url_prefix AS entry_url_prefix,
  exit_action.name AS exit_url_name, exit_action.url_prefix AS exit_url_prefix
FROM matomo_log_visit v
LEFT JOIN matomo_log_action entry_action ON entry_action.idaction = v.visit_entry_idaction_url
LEFT JOIN matomo_log_action exit_action ON exit_action.idaction = v.visit_exit_idaction_url
WHERE v.idvisit > ?${since ? ' AND v.visit_last_action_time >= ?' : ''}${until ? ' AND v.visit_first_action_time < ?' : ''}
ORDER BY v.idvisit
LIMIT ?`;
}

function actionsSql(since: boolean, until: boolean): string {
  return `SELECT lva.idlink_va, lva.idvisit, lva.idsite, lva.idvisitor, lva.server_time,
  lva.custom_float,
  url_action.type AS url_type, url_action.name AS url_name, url_action.url_prefix AS url_prefix,
  name_action.type AS name_type, name_action.name AS name_name,
  category_action.name AS event_category, action_action.name AS event_action,
  v.referer_type, v.referer_name, v.referer_url,
  v.campaign_name, v.campaign_source, v.campaign_medium,
  v.config_browser_name, v.config_browser_version, v.config_os,
  v.config_device_type, v.config_resolution,
  v.location_browser_lang, v.location_country, v.location_region, v.location_city,
  v.location_latitude, v.location_longitude
FROM matomo_log_link_visit_action lva
JOIN matomo_log_visit v ON v.idvisit = lva.idvisit
LEFT JOIN matomo_log_action url_action ON url_action.idaction = lva.idaction_url
LEFT JOIN matomo_log_action name_action ON name_action.idaction = lva.idaction_name
LEFT JOIN matomo_log_action category_action ON category_action.idaction = lva.idaction_event_category
LEFT JOIN matomo_log_action action_action ON action_action.idaction = lva.idaction_event_action
WHERE lva.idlink_va > ?${since ? ' AND lva.server_time >= ?' : ''}${until ? ' AND lva.server_time < ?' : ''}
ORDER BY lva.idlink_va
LIMIT ?`;
}

export async function importMatomo(
  db: Db,
  source: SourceQuery,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const sinceParams = options.since === undefined ? [] : [`${options.since} 00:00:00`];
  const untilParams = options.until === undefined ? [] : [`${options.until} 00:00:00`];
  const rangeParams = [...sinceParams, ...untilParams];
  const report: ImportReport = {
    dryRun,
    sites: 0,
    sitesSkipped: 0,
    sessions: 0,
    events: 0,
    skipped: 0,
    days: [],
  };
  const days = new Map<string, DayTotal>();
  const timezones = new Map(listSites(db).map((site) => [site.id, site.timezone]));
  const existing = new Set(timezones.keys());

  // -- sites ----------------------------------------------------------------
  for await (const batch of batches(
    source,
    SQL_SITES,
    'idsite',
    watermark(db, 'site'),
    [],
    batchSize,
  )) {
    const rows = batch.rows as unknown as MatomoSiteRow[];
    const aliases = await siteAliases(
      source,
      rows.map((row) => row.idsite),
    );
    const created: NewSite[] = [];
    for (const row of rows) {
      const site = mapSite(row, aliases.get(row.idsite) ?? []);
      if (!timezones.has(row.idsite)) timezones.set(row.idsite, row.timezone);
      if (existing.has(row.idsite)) {
        report.sitesSkipped += 1;
        continue;
      }
      created.push(site);
      report.sites += 1;
    }
    if (!dryRun) {
      withWriteTransaction(db, () => {
        for (const site of created) createSite(db, site);
        setWatermark(db, 'site', batch.last);
      });
    }
  }
  options.log?.(`sites: ${report.sites} imported, ${report.sitesSkipped} already present`);

  // -- visits → sessions ------------------------------------------------------
  const hasSince = sinceParams.length > 0;
  const hasUntil = untilParams.length > 0;
  // With --since the date bounds the scan instead of the watermark: sessions
  // upsert by deterministic id, so re-reading repairs visits Matomo mutated
  // in place after the previous run saw them.
  for await (const batch of batches(
    source,
    visitsSql(hasSince, hasUntil),
    'idvisit',
    hasSince ? 0 : watermark(db, 'log_visit'),
    rangeParams,
    batchSize,
  )) {
    const sessions: SessionRow[] = [];
    for (const raw of batch.rows as unknown as MatomoVisitRow[]) {
      const timezone = timezones.get(raw.idsite);
      const session = timezone === undefined ? null : mapVisit(raw, timezone);
      if (session === null) {
        report.skipped += 1;
        continue;
      }
      sessions.push(session);
      dayTotal(days, session.site_id, session.local_date).visits += 1;
    }
    report.sessions += sessions.length;
    if (!dryRun) {
      withWriteTransaction(db, () => {
        upsertSessions(db, sessions);
        setWatermark(db, 'log_visit', batch.last);
      });
    }
    options.log?.(`visits: ${report.sessions} sessions so far`);
  }

  // -- actions → events -------------------------------------------------------
  const seqByVisit = new Map<number, number>();
  for await (const batch of batches(
    source,
    actionsSql(hasSince, hasUntil),
    'idlink_va',
    watermark(db, 'log_link_visit_action'),
    rangeParams,
    batchSize,
  )) {
    const events: EventRow[] = [];
    for (const raw of batch.rows as unknown as MatomoActionRow[]) {
      const timezone = timezones.get(raw.idsite);
      const mapped = timezone === undefined ? null : mapAction(raw, timezone);
      if (mapped === null) {
        report.skipped += 1;
        continue;
      }
      events.push({ ...mapped, seq: nextSeq(db, seqByVisit, raw.idvisit) });
      if (mapped.type === 'pageview') {
        dayTotal(days, mapped.site_id, mapped.local_date).pageviews += 1;
      }
    }
    report.events += events.length;
    if (!dryRun) {
      withWriteTransaction(db, () => {
        insertEvents(db, events);
        setWatermark(db, 'log_link_visit_action', batch.last);
      });
      pruneSeqMap(seqByVisit); // safe now: this batch's rows are committed, MAX(seq) re-seeds
    }
    options.log?.(`actions: ${report.events} events so far`);
  }

  report.days = [...days.values()].sort(
    (a, b) => a.site_id - b.site_id || a.local_date.localeCompare(b.local_date),
  );
  return report;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Bounded keyset pagination: `WHERE id > cursor ORDER BY id LIMIT n`, repeated. */
async function* batches(
  source: SourceQuery,
  sql: string,
  idColumn: string,
  start: number,
  extraParams: readonly unknown[],
  batchSize: number,
): AsyncGenerator<{ rows: Array<Record<string, unknown>>; last: number }> {
  let cursor = start;
  for (;;) {
    const rows = await source(sql, [cursor, ...extraParams, batchSize]);
    const lastRow = rows.at(-1);
    if (lastRow === undefined) return;
    const last = Number(lastRow[idColumn]);
    yield { rows, last };
    if (rows.length < batchSize) return;
    cursor = last;
  }
}

async function siteAliases(
  source: SourceQuery,
  ids: readonly number[],
): Promise<Map<number, string[]>> {
  const aliases = new Map<number, string[]>();
  if (ids.length === 0) return aliases;
  for (const row of await source(SQL_SITE_URLS, [ids])) {
    const id = Number(row.idsite);
    const urls = aliases.get(id);
    if (urls === undefined) aliases.set(id, [String(row.url)]);
    else urls.push(String(row.url));
  }
  return aliases;
}

function watermark(db: Db, table: string): number {
  return Number(getSetting(db, WATERMARK_PREFIX + table) ?? 0);
}

/** Only ever advances — a `--since` re-scan pages from 0 and must not lower it. */
function setWatermark(db: Db, table: string, id: number): void {
  if (id > watermark(db, table)) setSetting(db, WATERMARK_PREFIX + table, String(id));
}

/** Visits are near-contiguous in `idlink_va` order; entries this old are done. */
const SEQ_MAP_MAX = 10_000;

function pruneSeqMap(seqByVisit: Map<number, number>): void {
  if (seqByVisit.size <= SEQ_MAP_MAX) return;
  const drop = seqByVisit.size - SEQ_MAP_MAX;
  let dropped = 0;
  for (const key of seqByVisit.keys()) {
    if (dropped >= drop) break;
    seqByVisit.delete(key); // insertion order = oldest visit first
    dropped += 1;
  }
}

const SQL_MAX_SEQ = 'SELECT COALESCE(MAX(seq), 0) FROM events WHERE session_id = ?';

/**
 * 1-based per-visit position, in `idlink_va` order. A visit first seen this
 * run is seeded from the events already stored for its session, so a top-up
 * that lands mid-visit continues the sequence instead of restarting it.
 */
function nextSeq(db: Db, seqByVisit: Map<number, number>, idvisit: number): number {
  let seq = seqByVisit.get(idvisit);
  if (seq === undefined) {
    seq = stmt(db, SQL_MAX_SEQ).pluck().get(sessionIdForVisit(idvisit)) as number;
  }
  seq += 1;
  seqByVisit.set(idvisit, seq);
  return seq;
}

function dayTotal(days: Map<string, DayTotal>, siteId: number, date: string): DayTotal {
  const key = `${siteId}|${date}`;
  let entry = days.get(key);
  if (entry === undefined) {
    entry = { site_id: siteId, local_date: date, visits: 0, pageviews: 0 };
    days.set(key, entry);
  }
  return entry;
}
