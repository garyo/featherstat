import { isQueryError, type QueryResponse, type QueryResult } from '@featherstat/shared';
import {
  createSite,
  type Db,
  type EventRow,
  type MissingRow,
  openDb,
  type SessionRow,
  withWriteTransaction,
} from '../src/db/index.ts';
import { rebuildRollupDay } from '../src/rollup/rebuild.ts';

/** Fixtures shared by the server test suites — one copy of every factory and scaffold. */

/** An 8-byte id that reads unmistakably in hex dumps: byte `n`, eight times. */
export function binId(n: number): Uint8Array {
  return new Uint8Array(8).fill(n);
}

export const VISITOR = binId(1);
export const SESSION = binId(2);

const SITE_NAMES = ['one', 'two'] as const;

/** In-memory DB seeded with site 1 ('one.test') and optionally site 2 ('two.test'). */
export function openTestDb(siteCount: 1 | 2 = 1): Db {
  const db = openDb(':memory:');
  withWriteTransaction(db, () => {
    for (const [index, name] of SITE_NAMES.slice(0, siteCount).entries()) {
      createSite(db, { id: index + 1, name, domains: [`${name}.test`] });
    }
  });
  return db;
}

/**
 * Rebuilds every (site, day)'s rollup rows from whatever raw rows a test
 * seeded. Production maintains rollups inside the ingest flush (invariant 2's
 * single writer), so rollups cover all history by construction; a test that
 * writes `events`/`sessions` directly has stepped around that and must call
 * this before executing metric queries — the planner routes eligible shapes to
 * the rollup tables and an unsynced test would read zeros.
 */
export function syncRollups(db: Db): void {
  const days = db
    .prepare(
      `SELECT site_id, local_date FROM (
         SELECT DISTINCT site_id, local_date FROM events
         UNION SELECT DISTINCT site_id, local_date FROM sessions
       ) ORDER BY site_id, local_date`,
    )
    .all() as Array<{ site_id: number; local_date: string }>;
  for (const { site_id, local_date } of days) {
    withWriteTransaction(db, () => rebuildRollupDay(db, site_id, local_date));
  }
}

/** Narrows a batch entry to rows, failing loudly on an unexpected error entry. */
export function resultOf(response: QueryResponse, id: string): QueryResult {
  const entry = response.results[id];
  if (entry === undefined || isQueryError(entry)) {
    throw new Error(`expected rows for '${id}', got ${JSON.stringify(entry)}`);
  }
  return entry;
}

/** 2026-07-27 14:00 UTC = 10:00 EDT. */
export const T0 = Date.UTC(2026, 6, 27, 14);

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** 2023-11-14 17:33 UTC — an arbitrary fixed instant for row-level tests. */
const TS = 1_700_000_000_000;

export function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    site_id: 1,
    ts: TS,
    local_date: '2023-11-14',
    local_hour: 17,
    type: 'pageview',
    visitor_id: VISITOR,
    session_id: SESSION,
    seq: 1,
    ...overrides,
  };
}

/** A not-found hit: a direct request for a page that does not exist. */
export function missing(overrides: Partial<MissingRow> = {}): MissingRow {
  return {
    site_id: 1,
    ts: TS,
    local_date: '2023-11-14',
    local_hour: 17,
    path: '/no-such-page',
    ref_type: 'direct',
    ref_domain: null,
    ref_path: null,
    device_type: 'desktop',
    country: null,
    ...overrides,
  };
}

export function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION,
    site_id: 1,
    visitor_id: VISITOR,
    started_at: TS,
    last_seen_at: TS,
    local_date: '2023-11-14',
    local_hour: 17,
    pageviews: 1,
    events: 0,
    engaged_ms: 0,
    ...overrides,
  };
}
