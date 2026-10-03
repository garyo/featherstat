import { DAY_MS } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { binId, event, openTestDb, session, syncRollups } from '../../test/rows.ts';
import {
  type Db,
  dataVersion,
  getSetting,
  insertEvents,
  setSetting,
  stmt,
  tombstoneSite,
  updateSite,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { META_RAW_HORIZON, setRollupMeta } from '../rollup/apply.ts';
import { verifyRollupDay } from '../rollup/verify.ts';
import {
  forgetTimezoneBackfill,
  requestTimezoneBackfill,
  runTimezoneBackfills,
} from './timezone-backfill.ts';

/**
 * The timezone backfill (docs/03 § Timezones): a site's stored local clocks
 * re-derived in its new zone, its rollups rebuilt, the epoch bumped.
 */

/** 02:00 UTC on Jul 27: 22:00 on Jul 26 in New York, 11:00 on Jul 27 in Tokyo. */
const AT = Date.UTC(2026, 6, 27, 2);
const NY_DATE = '2026-07-26';
const TOKYO_DATE = '2026-07-27';
/** A day later: nothing seeded at AT is still a visit the sessionizer could hold. */
const LATER = AT + DAY_MS;

/** One visit per site, stamped in New York (every test site's zone). */
function seed(db: Db, overrides: { lastSeenAt?: number } = {}): void {
  withWriteTransaction(db, () => {
    for (const site of [1, 2]) {
      const common = { site_id: site, local_date: NY_DATE, local_hour: 22 };
      insertEvents(db, [
        event({ ...common, ts: AT, session_id: binId(site), seq: 1 }),
        event({ ...common, ts: AT + 60_000, session_id: binId(site), seq: 2 }),
      ]);
      upsertSessions(db, [
        session({
          ...common,
          id: binId(site),
          started_at: AT,
          last_seen_at: overrides.lastSeenAt ?? AT + 60_000,
          pageviews: 2,
        }),
      ]);
    }
  });
  syncRollups(db);
}

function rezone(db: Db, siteId: number, timezone: string): void {
  withWriteTransaction(db, () => {
    updateSite(db, siteId, { timezone });
    requestTimezoneBackfill(db, siteId);
  });
}

interface Clock {
  local_date: string;
  local_hour: number;
}

function clocks(db: Db, table: 'events' | 'sessions', siteId: number): Clock[] {
  return stmt<Clock>(
    db,
    `SELECT local_date, local_hour FROM ${table} WHERE site_id = ? ORDER BY rowid`,
  ).all(siteId) as Clock[];
}

function rollupDays(db: Db, siteId: number): string[] {
  return stmt<string>(
    db,
    `SELECT local_date FROM rollup_dim_day WHERE site_id = ?
     UNION SELECT local_date FROM rollup_sessions_day WHERE site_id = ?
     UNION SELECT local_date FROM rollup_traffic_hour WHERE site_id = ? ORDER BY 1`,
  )
    .pluck()
    .all(siteId, siteId, siteId) as string[];
}

const tokyo = { local_date: TOKYO_DATE, local_hour: 11 };
const newYork = { local_date: NY_DATE, local_hour: 22 };

describe('timezone backfill', () => {
  it("re-dates the site's events and sessions, and nothing of any other site", async () => {
    const db = openTestDb(2);
    seed(db);
    rezone(db, 1, 'Asia/Tokyo');
    const result = await runTimezoneBackfills(db, { now: () => LATER });

    expect(result).toEqual({ completed: 1, rows: 3 }); // two events + one session
    expect(clocks(db, 'events', 1)).toEqual([tokyo, tokyo]);
    expect(clocks(db, 'sessions', 1)).toEqual([tokyo]);
    expect(clocks(db, 'events', 2)).toEqual([newYork, newYork]);
    expect(clocks(db, 'sessions', 2)).toEqual([newYork]);
    expect(getSetting(db, 'tz_backfill:1:events')).toBeUndefined();
    expect(getSetting(db, 'tz_backfill_dirty:1')).toBeUndefined();
    db.close();
  });

  it('rebuilds the rollups onto the new days and clears the days only the old zone had', async () => {
    const db = openTestDb(2);
    seed(db);
    rezone(db, 1, 'Asia/Tokyo');
    await runTimezoneBackfills(db, { now: () => LATER });

    expect(rollupDays(db, 1)).toEqual([TOKYO_DATE]); // Jul 26 held nothing in Tokyo
    expect(verifyRollupDay(db, 1, TOKYO_DATE)).toEqual([]);
    expect(verifyRollupDay(db, 1, NY_DATE)).toEqual([]);
    expect(rollupDays(db, 2)).toEqual([NY_DATE]);
    db.close();
  });

  it('bumps the data epoch when it re-dated anything, and only then', async () => {
    const db = openTestDb(2);
    seed(db);
    const before = dataVersion(db);
    rezone(db, 1, 'Asia/Tokyo');
    await runTimezoneBackfills(db, { now: () => LATER });
    const after = dataVersion(db);
    expect(after).toBeGreaterThan(before);

    // Same instants, and a zone that agrees with Tokyo on every one of them.
    rezone(db, 1, 'Asia/Seoul');
    expect(await runTimezoneBackfills(db, { now: () => LATER })).toEqual({ completed: 1, rows: 0 });
    expect(dataVersion(db)).toBe(after);
    db.close();
  });

  it('resumes across chunks and converges on the same rows', async () => {
    const db = openTestDb(2);
    seed(db);
    rezone(db, 1, 'Asia/Tokyo');
    const result = await runTimezoneBackfills(db, { batchSize: 1, now: () => LATER });
    expect(result.rows).toBe(3);
    expect(clocks(db, 'events', 1)).toEqual([tokyo, tokyo]);
    db.close();
  });

  it('leaves a visit the sessionizer may still hold on its start date; its events move', async () => {
    const db = openTestDb(2);
    seed(db, { lastSeenAt: LATER - 60_000 }); // still beating a day later
    rezone(db, 1, 'Asia/Tokyo');
    await runTimezoneBackfills(db, { now: () => LATER });

    expect(clocks(db, 'sessions', 1)).toEqual([newYork]);
    expect(clocks(db, 'events', 1)).toEqual([tokyo, tokyo]);
    // Rollups agree with raw on both days: the held visit's day keeps its row.
    expect(verifyRollupDay(db, 1, NY_DATE)).toEqual([]);
    expect(verifyRollupDay(db, 1, TOKYO_DATE)).toEqual([]);
    db.close();
  });

  it('never clears a rollup day whose raw rows retention may have pruned', async () => {
    const db = openTestDb(2);
    seed(db);
    // The floor sits on the old day: its rollups are the only record left of
    // whatever retention took from it.
    withWriteTransaction(db, () => setRollupMeta(db, META_RAW_HORIZON, String(AT)));
    rezone(db, 1, 'Asia/Tokyo');
    await runTimezoneBackfills(db, { now: () => LATER });
    expect(rollupDays(db, 1)).toContain(NY_DATE);
    db.close();
  });

  it('ends in the newest zone when the zone changes again mid-run', async () => {
    const db = openTestDb(2);
    seed(db);
    rezone(db, 1, 'Asia/Tokyo');
    const running = runTimezoneBackfills(db, { batchSize: 1, now: () => LATER });
    rezone(db, 1, 'UTC'); // lands before the first chunk: the run yields first
    await running;

    const utc = { local_date: TOKYO_DATE, local_hour: 2 };
    expect(clocks(db, 'events', 1)).toEqual([utc, utc]);
    expect(clocks(db, 'sessions', 1)).toEqual([utc]);
    expect(getSetting(db, 'tz_backfill:1:events')).toBeUndefined();
    db.close();
  });

  it('drops the work of a site deleted before it ran — the purge owns those rows', async () => {
    const db = openTestDb(2);
    seed(db);
    rezone(db, 1, 'Asia/Tokyo');
    withWriteTransaction(db, () => tombstoneSite(db, 1, LATER));
    const before = dataVersion(db);
    expect(await runTimezoneBackfills(db, { now: () => LATER })).toEqual({ completed: 0, rows: 0 });
    expect(clocks(db, 'events', 1)).toEqual([newYork, newYork]);
    expect(dataVersion(db)).toBe(before);
    expect(getSetting(db, 'tz_backfill:1:events')).toBeUndefined();
    expect(getSetting(db, 'tz_backfill:1:sessions')).toBeUndefined();
    db.close();
  });

  it('does nothing when nothing is enqueued', async () => {
    const db = openTestDb(2);
    seed(db);
    const before = dataVersion(db);
    expect(await runTimezoneBackfills(db)).toEqual({ completed: 0, rows: 0 });
    expect(dataVersion(db)).toBe(before);
    db.close();
  });
});

describe('forgetTimezoneBackfill', () => {
  it("drops the site's watermarks and debt, and nothing of any other site", () => {
    const db = openTestDb(2);
    withWriteTransaction(db, () => {
      for (const site of [1, 2]) {
        requestTimezoneBackfill(db, site);
        setSetting(db, `tz_backfill_dirty:${site}`, '1');
      }
      forgetTimezoneBackfill(db, 1);
    });
    const keys = stmt<string>(
      db,
      "SELECT key FROM settings WHERE key LIKE 'tz_backfill%' ORDER BY 1",
    )
      .pluck()
      .all();
    expect(keys).toEqual([
      'tz_backfill:2:events',
      'tz_backfill:2:missing_hits',
      'tz_backfill:2:sessions',
      'tz_backfill_dirty:2',
    ]);
    db.close();
  });
});

describe('the epoch survives a crash mid-rewrite', () => {
  it('rebuilds and bumps even when the resuming run changes nothing itself', async () => {
    const db = openTestDb(2);
    seed(db);
    rezone(db, 1, 'Asia/Tokyo');
    await runTimezoneBackfills(db, { now: () => LATER });
    const settled = dataVersion(db);

    // The crash: rows re-dated, the epilogue never reached.
    withWriteTransaction(db, () => {
      requestTimezoneBackfill(db, 1);
      setSetting(db, 'tz_backfill_dirty:1', '1');
      db.prepare('DELETE FROM rollup_dim_day WHERE site_id = 1').run();
    });

    const result = await runTimezoneBackfills(db, { now: () => LATER });
    expect(result.rows).toBe(0);
    expect(dataVersion(db)).toBeGreaterThan(settled);
    expect(verifyRollupDay(db, 1, TOKYO_DATE)).toEqual([]);
    expect(getSetting(db, 'tz_backfill_dirty:1')).toBeUndefined();
    db.close();
  });
});
