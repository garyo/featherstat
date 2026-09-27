import { ENGAGEMENT_THRESHOLD_MS } from '@featherstat/shared';
import { type Db, stmt } from '../db/index.ts';
import { EVENT_DIM_SELECTS, SESSION_DIM_SELECTS, TRAFFIC_HOUR_SELECT } from './rebuild.ts';

/**
 * The equivalence oracle (docs/03 § Rollups): recompute one (site, day) from
 * raw rows — the exact SELECTs `rebuild.ts` repairs with — and diff against the
 * stored rollup rows. An empty return is the ratchet's green: the incremental
 * flush path and a from-scratch recompute agree cell for cell.
 *
 * Read-only on purpose; repairing is `rebuildRollupDay`'s job.
 */

export interface RollupDiscrepancy {
  table: 'rollup_traffic_hour' | 'rollup_dim_day' | 'rollup_sessions_day';
  /** The row's key columns past (site, date), joined with '|'. */
  key: string;
  column: string;
  expected: number;
  actual: number;
}

type Row = Record<string, number | string | null>;

const STORED_TRAFFIC = `SELECT local_hour, hits, actions, pageviews, events, outlinks, downloads,
  event_value_sum
FROM rollup_traffic_hour WHERE site_id = ? AND local_date = ?`;

const STORED_DIM_DAY = `SELECT dim_id, dim_value, dim_null, hits, actions, pageviews, events,
  outlinks, downloads, event_value_sum, visitors, sessions_touched
FROM rollup_dim_day WHERE site_id = ? AND local_date = ?`;

const STORED_SESSIONS_DAY = `SELECT dim_id, dim_value, dim_null, visits, measured_sessions,
  engaged_ms, bounced, session_pageviews
FROM rollup_sessions_day WHERE site_id = ? AND local_date = ?`;

export function verifyRollupDay(db: Db, siteId: number, localDate: string): RollupDiscrepancy[] {
  const out: RollupDiscrepancy[] = [];

  diff(
    out,
    'rollup_traffic_hour',
    ['local_hour'],
    stmt<Row>(db, TRAFFIC_HOUR_SELECT).all(siteId, localDate),
    stmt<Row>(db, STORED_TRAFFIC).all(siteId, localDate),
  );

  const expectedDims = EVENT_DIM_SELECTS.flatMap(({ sql }) =>
    stmt<Row>(db, sql).all(siteId, localDate),
  );
  diff(
    out,
    'rollup_dim_day',
    ['dim_id', 'dim_value', 'dim_null'],
    expectedDims,
    stmt<Row>(db, STORED_DIM_DAY).all(siteId, localDate),
  );

  const expectedSessions = SESSION_DIM_SELECTS.flatMap(({ sql }) =>
    stmt<Row>(db, sql).all(ENGAGEMENT_THRESHOLD_MS, siteId, localDate),
  );
  diff(
    out,
    'rollup_sessions_day',
    ['dim_id', 'dim_value', 'dim_null'],
    expectedSessions,
    stmt<Row>(db, STORED_SESSIONS_DAY).all(siteId, localDate),
  );

  return out;
}

/**
 * Both directions: a stored row the recompute would not produce is as much a
 * drift as a wrong number — a missing side reads as all-zero cells.
 */
function diff(
  out: RollupDiscrepancy[],
  table: RollupDiscrepancy['table'],
  keyColumns: readonly string[],
  expectedRows: readonly Row[],
  actualRows: readonly Row[],
): void {
  const keyOf = (row: Row): string => keyColumns.map((column) => row[column]).join('|');
  const expected = new Map(expectedRows.map((row) => [keyOf(row), row]));
  const actual = new Map(actualRows.map((row) => [keyOf(row), row]));
  const valueColumns = (row: Row): string[] =>
    Object.keys(row).filter(
      (column) => !keyColumns.includes(column) && column !== 'site_id' && column !== 'local_date',
    );

  for (const [key, want] of expected) {
    const got = actual.get(key);
    for (const column of valueColumns(want)) {
      const wantValue = Number(want[column] ?? 0);
      const gotValue = Number(got?.[column] ?? 0);
      if (differs(wantValue, gotValue)) {
        out.push({ table, key, column, expected: wantValue, actual: gotValue });
      }
    }
  }
  for (const [key, got] of actual) {
    if (expected.has(key)) continue;
    for (const column of valueColumns(got)) {
      const gotValue = Number(got[column] ?? 0);
      if (differs(0, gotValue)) out.push({ table, key, column, expected: 0, actual: gotValue });
    }
  }
}

/** Counters are exact; `event_value_sum` is a REAL accumulated in two different
 * orders (JS per flush vs SQLite per day), so it gets float tolerance. */
function differs(expected: number, actual: number): boolean {
  return Math.abs(expected - actual) > 1e-6 * Math.max(1, Math.abs(expected));
}
