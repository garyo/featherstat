import { DAY_MS, localClock } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { binId, event, session, syncRollups } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  insertEvents,
  openDb,
  stmt,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { verifyRollupDay } from '../rollup/verify.ts';
import { runReconcile } from './reconcile.ts';

/** Noon UTC, so "yesterday" is unambiguous in both fixture timezones. */
const NOW = Date.UTC(2026, 6, 27, 12);

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'one', domains: ['one.test'] });
    createSite(db, { id: 2, name: 'two', domains: ['two.test'], timezone: 'Asia/Tokyo' });
  });
});

afterEach(() => {
  db.close();
});

/** One visit on `localDate` for `siteId`, raw + rollups in step. */
function seedDay(siteId: number, localDate: string, n: number): void {
  const ts = Date.parse(`${localDate}T00:00:00Z`);
  withWriteTransaction(db, () => {
    insertEvents(db, [
      { ...event({ site_id: siteId, ts, local_date: localDate }), session_id: binId(n) },
    ]);
    upsertSessions(db, [
      session({ id: binId(n), site_id: siteId, started_at: ts, local_date: localDate }),
    ]);
  });
  syncRollups(db);
}

function yesterdayOf(timezone: string): string {
  const today = localClock(timezone, NOW).date;
  return new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

describe('runReconcile', () => {
  it('verifies yesterday per site and finds nothing when rollups are honest', async () => {
    seedDay(1, yesterdayOf('UTC'), 1);
    seedDay(2, yesterdayOf('Asia/Tokyo'), 2);

    expect(await runReconcile(db, { now: () => NOW })).toEqual({
      checked: 2,
      repaired: 0,
      cells: 0,
    });
  });

  it('logs a drifted day loudly as a defect and repairs it by rebuilding', async () => {
    const yesterday = yesterdayOf('UTC');
    seedDay(1, yesterday, 1);
    withWriteTransaction(db, () => {
      stmt(
        db,
        'UPDATE rollup_dim_day SET pageviews = pageviews + 5 WHERE site_id = 1 AND local_date = ?',
      ).run(yesterday);
    });
    expect(verifyRollupDay(db, 1, yesterday).length).toBeGreaterThan(0);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runReconcile(db, { now: () => NOW });

    expect(result.checked).toBe(2);
    expect(result.repaired).toBe(1);
    expect(result.cells).toBeGreaterThan(0);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('delta-logic BUG'));
    expect(verifyRollupDay(db, 1, yesterday)).toEqual([]);
    logged.mockRestore();
  });

  it('leaves other days alone — the job is O(day), not O(history)', async () => {
    const old = '2026-06-01';
    seedDay(1, old, 1);
    withWriteTransaction(db, () => {
      stmt(
        db,
        'UPDATE rollup_dim_day SET pageviews = pageviews + 5 WHERE site_id = 1 AND local_date = ?',
      ).run(old);
    });

    expect(await runReconcile(db, { now: () => NOW })).toMatchObject({ repaired: 0 });
    // The stale old day stands (rebuildAllRollups is the repair for history).
    expect(verifyRollupDay(db, 1, old).length).toBeGreaterThan(0);
  });
});
