import { PING_CLAMP_MS, READ_MILESTONE, SESSION_TIMEOUT_MS } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { binId, event, openTestDb, session, syncRollups } from '../../test/rows.ts';
import {
  type Db,
  dataVersion,
  type EventRow,
  getSetting,
  insertEvents,
  setSetting,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { verifyRollupDay } from '../rollup/verify.ts';
import { runMissingBackfill } from './missing-backfill.ts';

const DAY = '2023-11-14';
const T = Date.UTC(2023, 10, 14, 17);
/** Long after every visit below has gone quiet. */
const LATER = T + 2 * SESSION_TIMEOUT_MS;

let db: Db;

beforeEach(() => {
  db = openTestDb();
  withWriteTransaction(db, () => setSetting(db, 'missing_backfill:events', '0'));
});

afterEach(() => {
  db.close();
});

/**
 * One visit's rows, in order: `seq` and the session id filled in, and the
 * visit's attribution copied onto every row, as ingest does.
 */
function visit(id: number, rows: readonly Partial<EventRow>[], attribution = {}): void {
  const sid = binId(id);
  const events = rows.map((row, i) =>
    event({ session_id: sid, seq: i + 1, ...attribution, ...row }),
  );
  const pages = events.filter((row) => row.type === 'pageview');
  withWriteTransaction(db, () => {
    insertEvents(db, events);
    upsertSessions(db, [
      session({
        id: sid,
        started_at: events[0]?.ts ?? T,
        last_seen_at: events[events.length - 1]?.ts ?? T,
        entry_path: pages[0]?.path ?? null,
        exit_path: pages[pages.length - 1]?.path ?? null,
        pageviews: pages.length,
        ...attribution,
      }),
    ]);
  });
}

const notFound = (ts: number, requested = '/gone'): Partial<EventRow> => ({
  ts,
  path: '/404',
  hostname: 'www.one.test',
  props: JSON.stringify({ missing: requested }),
});
const milestone = (ts: number): Partial<EventRow> => ({
  ts,
  type: 'event',
  path: '/404',
  event_category: READ_MILESTONE.category,
  event_action: READ_MILESTONE.action,
});
const ping = (ts: number, path: string): Partial<EventRow> => ({ ts, type: 'ping', path });

const all = (sql: string): unknown[] => db.prepare(sql).all();

describe('runMissingBackfill', () => {
  it('moves a visit that saw only a not-found page out of traffic, whole', async () => {
    visit(1, [notFound(T), ping(T + 15_000, '/404'), milestone(T + 20_000)], {
      ref_type: 'referral',
      ref_domain: 'blog.test',
    });
    syncRollups(db);

    const result = await runMissingBackfill(db, { now: () => LATER });

    expect(result).toEqual({ completed: true, moved: 1, visits: 1 });
    expect(all('SELECT * FROM events')).toEqual([]);
    expect(all('SELECT * FROM sessions')).toEqual([]);
    expect(all('SELECT path, ref_type, ref_domain, ref_path FROM missing_hits')).toEqual([
      { path: '/gone', ref_type: 'referral', ref_domain: 'blog.test', ref_path: null },
    ]);
  });

  it('recounts a visit with real pages from what remains, crediting the page that linked', async () => {
    visit(1, [
      { ts: T, path: '/a' },
      notFound(T + 10_000),
      ping(T + 25_000, '/404'),
      { ts: T + 40_000, path: '/b' },
      ping(T + 55_000, '/b'),
    ]);

    const result = await runMissingBackfill(db, { now: () => LATER });

    expect(result).toEqual({ completed: true, moved: 1, visits: 0 });
    expect(all('SELECT path, type FROM events ORDER BY seq')).toEqual([
      { path: '/a', type: 'pageview' },
      { path: '/b', type: 'pageview' },
      { path: '/b', type: 'ping' },
    ]);
    expect(
      db
        .prepare(
          'SELECT entry_path, exit_path, pageviews, events, engaged_ms, last_seen_at FROM sessions',
        )
        .get(),
    ).toEqual({
      entry_path: '/a',
      exit_path: '/b',
      pageviews: 2,
      events: 0,
      engaged_ms: PING_CLAMP_MS + 15_000,
      last_seen_at: T + 55_000,
    });
    expect(all('SELECT ref_type, ref_domain, ref_path FROM missing_hits')).toEqual([
      { ref_type: 'internal', ref_domain: 'one.test', ref_path: '/a' },
    ]);
  });

  it('takes what a not-found page sent after its visit had gone, wherever it landed', async () => {
    // A read milestone that made a visit of its own, and a heartbeat that
    // revived the visitor's earlier, real visit.
    visit(1, [milestone(T)], { pageviews: 0 });
    visit(2, [{ ts: T, path: '/a' }, ping(T + 15_000, '/404')]);

    const result = await runMissingBackfill(db, { now: () => LATER });

    expect(result).toEqual({ completed: true, moved: 0, visits: 1 });
    expect(all('SELECT path, type FROM events')).toEqual([{ path: '/a', type: 'pageview' }]);
    expect(db.prepare('SELECT engaged_ms, last_seen_at FROM sessions').get()).toEqual({
      engaged_ms: 0,
      last_seen_at: T,
    });
  });

  it('takes the older /404 page views that never carried the prop', async () => {
    visit(1, [{ ts: T, path: '/404' }]);

    await runMissingBackfill(db, { now: () => LATER });

    expect(all('SELECT path FROM missing_hits')).toEqual([{ path: null }]);
    expect(all('SELECT * FROM sessions')).toEqual([]);
  });

  it('leaves a visit the live sessionizer may hold, and comes back for it', async () => {
    visit(1, [notFound(T)]);

    const early = await runMissingBackfill(db, { now: () => T + 60_000 });
    expect(early).toEqual({ completed: false, moved: 0, visits: 0 });
    expect(getSetting(db, 'missing_backfill:events')).toBe('0');

    const later = await runMissingBackfill(db, { now: () => LATER });
    expect(later).toEqual({ completed: true, moved: 1, visits: 1 });
    expect(getSetting(db, 'missing_backfill:events')).toBeUndefined();
  });

  it('rebuilds the rollups it invalidated and expires every cached answer', async () => {
    visit(1, [{ ts: T, path: '/a' }]);
    visit(2, [notFound(T + 1_000)]);
    syncRollups(db);
    const before = dataVersion(db);

    await runMissingBackfill(db, { now: () => LATER });

    expect(verifyRollupDay(db, 1, DAY)).toEqual([]);
    expect(dataVersion(db)).toBeGreaterThan(before);
  });

  it('owes nothing, and touches nothing, when there was nothing to move', async () => {
    visit(1, [{ ts: T, path: '/a' }]);
    const before = dataVersion(db);

    const result = await runMissingBackfill(db, { now: () => LATER });

    expect(result).toEqual({ completed: true, moved: 0, visits: 0 });
    expect(dataVersion(db)).toBe(before);
    expect(getSetting(db, 'missing_backfill:events')).toBeUndefined();
  });
});
