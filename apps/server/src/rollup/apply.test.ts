import { ENGAGEMENT_THRESHOLD_MS, type Hit } from '@featherstat/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_UA, T0 } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  openDb,
  setSetting,
  stmt,
  withWriteTransaction,
} from '../db/index.ts';
import { uidEnabledKey } from '../pipeline/identity.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';
import {
  getRollupMeta,
  META_ENGAGEMENT_THRESHOLD,
  rollupNeedsRebuild,
  setRollupMeta,
} from './apply.ts';
import { rebuildAllRollups } from './rebuild.ts';
import { verifyRollupDay } from './verify.ts';

/**
 * Targeted rollup-maintenance scenarios: the shapes the incremental write path
 * can get wrong in ways a happy-path corpus never exposes — a session that
 * un-bounces, one that spans local midnight, and the two paths where a session
 * row is read back from the store (restart, revival) and must NOT be booked as
 * a new visit. The broad flush-vs-rebuild equivalence lives in
 * `test/replay/rollup-equivalence.test.ts`; this file is the microscope.
 */

/** Long enough that only explicit `flush()` calls ever land. */
const MANUAL_FLUSH_MS = 3_600_000;

function openSiteDb(timezone: string, uidEnabled = false): Db {
  const db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'one', domains: ['one.test'], timezone });
    if (uidEnabled) setSetting(db, uidEnabledKey(1), '1');
  });
  return db;
}

function send(pipeline: Pipeline, hit: Hit, receivedAt: number, ip = '192.0.2.10'): void {
  pipeline.sink([hit], { ip, userAgent: DESKTOP_UA, receivedAt });
}

interface SessionsDayRow {
  visits: number;
  measured_sessions: number;
  engaged_ms: number;
  bounced: number;
  session_pageviews: number;
}

function sessionsDay(db: Db, localDate: string, dimId = 0, value = ''): SessionsDayRow | undefined {
  return stmt<SessionsDayRow>(
    db,
    `SELECT visits, measured_sessions, engaged_ms, bounced, session_pageviews
     FROM rollup_sessions_day
     WHERE site_id = 1 AND local_date = ? AND dim_id = ? AND dim_value = ?`,
  ).get(localDate, dimId, value);
}

/** Every (site, day) raw rows touch must verify clean — the equivalence claim. */
function verifyAll(db: Db): unknown[] {
  const days = stmt<{ site_id: number; local_date: string }>(
    db,
    `SELECT DISTINCT site_id, local_date FROM events
     UNION SELECT DISTINCT site_id, local_date FROM sessions`,
  ).all() as Array<{ site_id: number; local_date: string }>;
  return days.flatMap(({ site_id, local_date }) => verifyRollupDay(db, site_id, local_date));
}

const EXIT_PATH_DIM = 21;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyRollups (flush-incremental)', () => {
  it('un-bounces a session and moves its exit_path row when later hits arrive', () => {
    const db = openSiteDb('UTC');
    const pipeline = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_MS });
    const day = '2026-07-27';

    send(pipeline, { siteId: 1, type: 'pageview', url: 'https://one.test/a' }, T0);
    pipeline.flush();
    expect(sessionsDay(db, day)).toEqual({
      visits: 1,
      measured_sessions: 0,
      engaged_ms: 0,
      bounced: 1,
      session_pageviews: 1,
    });
    expect(sessionsDay(db, day, EXIT_PATH_DIM, '/a')?.visits).toBe(1);

    // 20 s later a second page: engagement lands, the bounce is TAKEN BACK
    // (−1 on the same day's row), and the exit moves from /a to /b.
    send(pipeline, { siteId: 1, type: 'pageview', url: 'https://one.test/b' }, T0 + 20_000);
    pipeline.flush();
    expect(sessionsDay(db, day)).toEqual({
      visits: 1,
      measured_sessions: 1,
      engaged_ms: 20_000,
      bounced: 0,
      session_pageviews: 2,
    });
    expect(sessionsDay(db, day, EXIT_PATH_DIM, '/a')?.visits).toBe(0);
    expect(sessionsDay(db, day, EXIT_PATH_DIM, '/b')?.visits).toBe(1);

    expect(verifyAll(db)).toEqual([]);
    pipeline.shutdown();
    db.close();
  });

  it('keeps a midnight-spanning session on the day it STARTED; its late hits on theirs', () => {
    // Only a uid-stable visitor can carry a session across local midnight —
    // fingerprint ids rotate with the daily salt (docs/03 § Identity).
    const db = openSiteDb('UTC', true);
    const pipeline = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_MS });
    const uid = 'reader-1';

    send(
      pipeline,
      { siteId: 1, type: 'pageview', url: 'https://one.test/late', uid },
      Date.UTC(2026, 6, 27, 23, 58),
    );
    pipeline.flush();
    send(
      pipeline,
      { siteId: 1, type: 'pageview', url: 'https://one.test/later', uid },
      Date.UTC(2026, 6, 28, 0, 10),
    );
    pipeline.flush();

    // The visit and BOTH its pageview counters sit on the 27th…
    expect(sessionsDay(db, '2026-07-27')?.visits).toBe(1);
    expect(sessionsDay(db, '2026-07-27')?.session_pageviews).toBe(2);
    expect(sessionsDay(db, '2026-07-28')).toBeUndefined();
    // …while the second hit itself is the 28th's traffic.
    const pageviews = (date: string): number =>
      stmt<number>(
        db,
        'SELECT COALESCE(SUM(pageviews), 0) FROM rollup_traffic_hour WHERE site_id = 1 AND local_date = ?',
      )
        .pluck()
        .get(date) as number;
    expect(pageviews('2026-07-27')).toBe(1);
    expect(pageviews('2026-07-28')).toBe(1);

    expect(verifyAll(db)).toEqual([]);
    pipeline.shutdown();
    db.close();
  });

  it('restart: a restored open session continues as ONE visit, not two', () => {
    const db = openSiteDb('UTC', true);
    const now = Date.now();

    const first = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_MS });
    send(
      first,
      { siteId: 1, type: 'pageview', url: 'https://one.test/a', uid: 'u1' },
      now - 60_000,
    );
    first.shutdown(); // flushes

    // New process: loadOpenSessions restores the row; the batcher's snapshot
    // must be seeded from it or this flush books a second visit.
    const second = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_MS });
    send(second, { siteId: 1, type: 'pageview', url: 'https://one.test/b', uid: 'u1' }, now);
    second.shutdown();

    const totalVisits = stmt<number>(
      db,
      'SELECT COALESCE(SUM(visits), 0) FROM rollup_sessions_day WHERE dim_id = 0',
    )
      .pluck()
      .get() as number;
    expect(totalVisits).toBe(1);
    expect(verifyAll(db)).toEqual([]);
    db.close();
  });

  it('revival: a heartbeat reviving a stored session continues it, not restarts it', () => {
    const db = openSiteDb('UTC', true);
    const now = Date.now();

    const first = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_MS });
    send(
      first,
      { siteId: 1, type: 'pageview', url: 'https://one.test/a', uid: 'u1' },
      now - 2 * 3_600_000,
    );
    first.shutdown();

    // 2 h idle: past the 30 min restore window, inside the 4 h revival window —
    // the ping reaches the session through the DB lookup, which must seed too.
    const second = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_MS });
    send(second, { siteId: 1, type: 'ping', url: 'https://one.test/a', uid: 'u1' }, now);
    second.shutdown();

    const rows = stmt<{ visits: number; engaged_ms: number }>(
      db,
      'SELECT visits, engaged_ms FROM rollup_sessions_day WHERE dim_id = 0',
    ).all() as Array<{ visits: number; engaged_ms: number }>;
    expect(rows.reduce((sum, row) => sum + row.visits, 0)).toBe(1);
    expect(verifyAll(db)).toEqual([]);
    db.close();
  });

  it('prunes presence rows past the horizon at day rollover; counts survive them', () => {
    const db = openSiteDb('UTC');
    const pipeline = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_MS });
    for (let day = 1; day <= 6; day += 1) {
      // A different visitor each day (distinct ip), flushed per day so every
      // rollover is a real flush boundary.
      send(
        pipeline,
        { siteId: 1, type: 'pageview', url: 'https://one.test/' },
        Date.UTC(2026, 6, day, 12),
        `192.0.2.${day}`,
      );
      pipeline.flush();
    }

    // The scaffolding is gone for closed days… (frontier 07-06, horizon 3 days)
    const seenDates = stmt<string>(db, 'SELECT DISTINCT local_date FROM rollup_visitor_seen')
      .pluck()
      .all() as string[];
    expect(Math.min(...seenDates.map((date) => Number(date.slice(-2))))).toBeGreaterThanOrEqual(3);
    // …but the distinct counts it kept exact survive it, on every day.
    for (let day = 1; day <= 6; day += 1) {
      const date = `2026-07-0${day}`;
      const visitors = stmt<number>(
        db,
        'SELECT visitors FROM rollup_dim_day WHERE site_id = 1 AND local_date = ? AND dim_id = 0',
      )
        .pluck()
        .get(date) as number;
      expect(visitors, date).toBe(1);
    }
    expect(verifyAll(db)).toEqual([]);
    pipeline.shutdown();
    db.close();
  });

  it('refuses session rollups under a changed engagement threshold until rebuilt', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openSiteDb('UTC');
    // Rollup history "built" under a different bounce definition. Recent
    // timestamps, so the rebuild also repopulates the presence tables — this
    // day is one ingest is still writing to.
    withWriteTransaction(db, () => setRollupMeta(db, META_ENGAGEMENT_THRESHOLD, '99999'));
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);

    const pipeline = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_MS });
    send(pipeline, { siteId: 1, type: 'pageview', url: 'https://one.test/a' }, now - 60_000);
    pipeline.flush();

    // Loud, flagged, and the session side held back; the event side continued.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SUSPENDED'));
    expect(rollupNeedsRebuild(db)).toBe(true);
    expect(sessionsDay(db, day)).toBeUndefined();
    expect(stmt(db, 'SELECT COUNT(*) FROM rollup_dim_day').pluck().get()).not.toBe(0);

    await rebuildAllRollups(db);
    expect(rollupNeedsRebuild(db)).toBe(false);
    expect(getRollupMeta(db, META_ENGAGEMENT_THRESHOLD)).toBe(String(ENGAGEMENT_THRESHOLD_MS));
    expect(sessionsDay(db, day)?.visits).toBe(1);

    // The suspension is lifted: a second visitor's flush applies again, and
    // its distinct increments compose with the rebuilt presence rows.
    send(pipeline, { siteId: 1, type: 'pageview', url: 'https://one.test/c' }, now, '192.0.2.99');
    pipeline.flush();
    expect(sessionsDay(db, day)?.visits).toBe(2);
    expect(verifyAll(db)).toEqual([]);
    pipeline.shutdown();
    db.close();
  });
});
