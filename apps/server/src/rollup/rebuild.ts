import { DAY_MS, ENGAGEMENT_THRESHOLD_MS } from '@featherstat/shared';
import { assertWritable, type Db, stmt, withWriteTransaction } from '../db/index.ts';
import { noteRollupsRebuilt } from './apply.ts';
import {
  EVENT_ROLLUP_DIMS,
  NO_DIM_ID,
  PRESENCE_HORIZON_DAYS,
  SESSION_ROLLUP_DIMS,
} from './tables.ts';

/**
 * Per-day delete + recompute from raw rows (docs/03 § Rollups): the repair path,
 * the importer target, and — verbatim, via `verify.ts` — the oracle the
 * equivalence ratchet holds the incremental write path against.
 *
 * Every dimension expression below comes from the closed tables in
 * `rollup/tables.ts`, never from a request (CLAUDE.md invariant 9); the site,
 * date and threshold are bound.
 */

// ---------------------------------------------------------------------------
// The recompute SELECTs — shared with verify.ts, so the oracle and the repair
// cannot drift apart. Each takes (site_id, local_date) bound in that order.
// ---------------------------------------------------------------------------

export const TRAFFIC_HOUR_SELECT = `SELECT site_id, local_date, local_hour,
  COUNT(*) AS hits,
  SUM(type != 'ping') AS actions,
  SUM(type = 'pageview') AS pageviews,
  SUM(type = 'event') AS events,
  SUM(type = 'outlink') AS outlinks,
  SUM(type = 'download') AS downloads,
  COALESCE(SUM(CASE WHEN type = 'event' THEN event_value END), 0) AS event_value_sum
FROM events WHERE site_id = ? AND local_date = ?
GROUP BY local_hour`;

/** One rolled group: the value/null expressions rows key on, from the closed dim tables. */
interface DimExprs {
  dimId: number;
  value: string;
  isNull: string;
}

function eventDimExprs(): DimExprs[] {
  return [
    { dimId: NO_DIM_ID, value: "''", isNull: '0' },
    ...EVENT_ROLLUP_DIMS.map(({ dimId, column }) => ({
      dimId,
      value: `COALESCE(${column}, '')`,
      isNull: `${column} IS NULL`,
    })),
  ];
}

function sessionDimExprs(): DimExprs[] {
  return [
    { dimId: NO_DIM_ID, value: "''", isNull: '0' },
    ...SESSION_ROLLUP_DIMS.map(({ dimId, column }) => ({
      dimId,
      value: `COALESCE(${column}, '')`,
      isNull: `${column} IS NULL`,
    })),
  ];
}

/** dim_day rows for one rolled group: non-ping rows only, distincts exact from raw. */
function dimDaySelect({ dimId, value, isNull }: DimExprs): string {
  return `SELECT site_id, local_date, ${dimId} AS dim_id, ${value} AS dim_value, ${isNull} AS dim_null,
  COUNT(*) AS actions,
  SUM(type = 'pageview') AS pageviews,
  SUM(type = 'event') AS events,
  SUM(type = 'outlink') AS outlinks,
  SUM(type = 'download') AS downloads,
  COALESCE(SUM(CASE WHEN type = 'event' THEN event_value END), 0) AS event_value_sum,
  COUNT(DISTINCT visitor_id) AS visitors,
  COUNT(DISTINCT session_id) AS sessions_touched
FROM events WHERE site_id = ? AND local_date = ? AND type != 'ping'
GROUP BY 4, 5`;
}

/** sessions_day rows for one rolled group; binds (threshold, site, date). */
function sessionsDaySelect({ dimId, value, isNull }: DimExprs): string {
  return `SELECT site_id, local_date, ${dimId} AS dim_id, ${value} AS dim_value, ${isNull} AS dim_null,
  COUNT(*) AS visits,
  SUM(engaged_ms > 0) AS measured_sessions,
  SUM(engaged_ms) AS engaged_ms,
  SUM(pageviews = 1 AND events = 0 AND engaged_ms < ?) AS bounced,
  SUM(pageviews) AS session_pageviews
FROM sessions WHERE site_id = ? AND local_date = ?
GROUP BY 4, 5`;
}

function seenSelect(
  table: 'visitor_id' | 'session_id',
  { dimId, value, isNull }: DimExprs,
): string {
  return `SELECT DISTINCT site_id, local_date, ${dimId}, ${value}, ${isNull}, ${table}
FROM events WHERE site_id = ? AND local_date = ? AND type != 'ping'`;
}

export const EVENT_DIM_SELECTS: ReadonlyArray<{ dimId: number; sql: string }> = eventDimExprs().map(
  (exprs) => ({ dimId: exprs.dimId, sql: dimDaySelect(exprs) }),
);

export const SESSION_DIM_SELECTS: ReadonlyArray<{ dimId: number; sql: string }> =
  sessionDimExprs().map((exprs) => ({ dimId: exprs.dimId, sql: sessionsDaySelect(exprs) }));

const VISITOR_SEEN_INSERTS = eventDimExprs().map(
  (exprs) => `INSERT OR IGNORE INTO rollup_visitor_seen ${seenSelect('visitor_id', exprs)}`,
);
const SESSION_SEEN_INSERTS = eventDimExprs().map(
  (exprs) => `INSERT OR IGNORE INTO rollup_session_seen ${seenSelect('session_id', exprs)}`,
);

const ROLLUP_TABLES = [
  'rollup_traffic_hour',
  'rollup_dim_day',
  'rollup_sessions_day',
  'rollup_visitor_seen',
  'rollup_session_seen',
] as const;

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

export interface RebuildDayOptions {
  now?: () => number;
  /** Override for tests; production uses `PRESENCE_HORIZON_DAYS`. */
  presenceHorizonDays?: number;
}

/**
 * Recomputes one (site, local day)'s rollup rows from raw events/sessions.
 * Must run inside `withWriteTransaction` — `rebuildAllRollups` wraps each day
 * in its own so a long rebuild never starves the ingest flush.
 */
export function rebuildRollupDay(
  db: Db,
  siteId: number,
  localDate: string,
  options: RebuildDayOptions = {},
): void {
  assertWritable(db);
  for (const table of ROLLUP_TABLES) {
    stmt(db, `DELETE FROM ${table} WHERE site_id = ? AND local_date = ?`).run(siteId, localDate);
  }

  stmt(db, `INSERT INTO rollup_traffic_hour ${TRAFFIC_HOUR_SELECT}`).run(siteId, localDate);
  for (const { sql } of EVENT_DIM_SELECTS) {
    stmt(db, `INSERT INTO rollup_dim_day ${sql}`).run(siteId, localDate);
  }
  for (const { sql } of SESSION_DIM_SELECTS) {
    stmt(db, `INSERT INTO rollup_sessions_day ${sql}`).run(
      ENGAGEMENT_THRESHOLD_MS,
      siteId,
      localDate,
    );
  }

  // Presence rows exist so INGEST can keep the distincts exact; a day ingest
  // can no longer reach needs none (see PRESENCE_HORIZON_DAYS).
  const horizonDays = options.presenceHorizonDays ?? PRESENCE_HORIZON_DAYS;
  const horizon = (options.now?.() ?? Date.now()) - horizonDays * DAY_MS;
  if (Date.parse(`${localDate}T00:00:00Z`) >= horizon - DAY_MS) {
    for (const sql of VISITOR_SEEN_INSERTS) stmt(db, sql).run(siteId, localDate);
    for (const sql of SESSION_SEEN_INSERTS) stmt(db, sql).run(siteId, localDate);
  }
}

export interface RebuildAllOptions extends RebuildDayOptions {
  /** Restrict to one site (site deletion repair); default is every site with rows. */
  siteId?: number;
}

const SQL_ROLLUP_DAYS = `SELECT site_id, local_date FROM (
  SELECT DISTINCT site_id, local_date FROM events
  UNION
  SELECT DISTINCT site_id, local_date FROM sessions
) WHERE (? IS NULL OR site_id = ?) ORDER BY site_id, local_date`;

export interface RebuildResult {
  days: number;
}

/**
 * Full rebuild: every (site, day) with raw rows, one write transaction each,
 * yielding to the event loop between days (jobs/retention.ts's batching
 * discipline — SQLite is synchronous, so an unbroken rebuild would stall the
 * 200 ms ingest flush). A COMPLETE run re-stamps `rollup_meta`'s engagement
 * threshold and lifts any session-rollup suspension.
 */
export async function rebuildAllRollups(
  db: Db,
  options: RebuildAllOptions = {},
): Promise<RebuildResult> {
  const site = options.siteId ?? null;
  const days = stmt<{ site_id: number; local_date: string }>(db, SQL_ROLLUP_DAYS).all(
    site,
    site,
  ) as Array<{ site_id: number; local_date: string }>;

  let done = 0;
  for (const { site_id, local_date } of days) {
    if (done > 0) await new Promise((resolve) => setImmediate(resolve));
    withWriteTransaction(db, () => rebuildRollupDay(db, site_id, local_date, options));
    done += 1;
  }

  // A partial (per-site) rebuild proves nothing about the other sites' bounced
  // columns, so only the full run may lift the threshold suspension.
  if (options.siteId === undefined) {
    withWriteTransaction(db, () => noteRollupsRebuilt(db));
  }
  return { days: done };
}
