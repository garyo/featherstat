import { localClock } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { META_RAW_HORIZON, setRollupMeta } from './apply.ts';
import { rawCoversDay, rebuildAllRollups, rebuildRollupDay } from './rebuild.ts';

/**
 * Rollups outlive raw rows (docs/03 § Size & retention), so a recompute from
 * raw must never reach a day the retention floor may have cut into — it would
 * replace the only surviving record of that day with whatever raw is left.
 */

/** 03:00 UTC on the 10th: still the 9th in New York, already the 10th in Tokyo. */
const HORIZON = Date.UTC(2026, 5, 10, 3);
const DATES = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11'] as const;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'ny', domains: ['ny.test'], timezone: 'America/New_York' });
    createSite(db, { id: 2, name: 'tokyo', domains: ['tokyo.test'], timezone: 'Asia/Tokyo' });
    for (const siteId of [1, 2]) {
      for (const [i, local_date] of DATES.entries()) {
        const id = binId(siteId * 10 + i);
        insertEvents(db, [
          { ...event({ site_id: siteId, local_date }), session_id: id },
          { ...event({ site_id: siteId, local_date, seq: 2 }), session_id: id },
        ]);
        upsertSessions(db, [session({ id, site_id: siteId, local_date, pageviews: 2 })]);
      }
    }
  });
  syncRollups(db);
});

afterEach(() => {
  db.close();
});

function dimDay(siteId: number, localDate: string): unknown[] {
  return stmt(
    db,
    'SELECT * FROM rollup_dim_day WHERE site_id = ? AND local_date = ? ORDER BY dim_id, dim_value',
  ).all(siteId, localDate);
}

/** What a prune that cut the days part-way leaves: one of each day's two hits. */
function prunePartially(): void {
  withWriteTransaction(db, () => {
    stmt(db, 'DELETE FROM events WHERE seq = 2').run();
    setRollupMeta(db, META_RAW_HORIZON, String(HORIZON));
  });
}

describe('the raw floor', () => {
  it("is compared by each site's own local date, the floor's day included", () => {
    expect(localClock('America/New_York', HORIZON).date).toBe('2026-06-09');
    expect(rawCoversDay(db, 1, '2026-06-09')).toBe(true);
    withWriteTransaction(db, () => setRollupMeta(db, META_RAW_HORIZON, String(HORIZON)));

    expect(rawCoversDay(db, 1, '2026-06-09')).toBe(false);
    expect(rawCoversDay(db, 1, '2026-06-10')).toBe(true);
    expect(rawCoversDay(db, 2, '2026-06-10')).toBe(false);
    expect(rawCoversDay(db, 2, '2026-06-11')).toBe(true);
  });

  it('keeps a full rebuild off every day raw no longer covers', async () => {
    const before = DATES.map((date) => [dimDay(1, date), dimDay(2, date)]);
    prunePartially();

    const result = await rebuildAllRollups(db);

    // New York rebuilds the 10th and 11th, Tokyo only the 11th.
    expect(result.days).toBe(3);
    expect(dimDay(1, '2026-06-08')).toEqual(before[0]?.[0]);
    expect(dimDay(1, '2026-06-09')).toEqual(before[1]?.[0]);
    expect(dimDay(2, '2026-06-10')).toEqual(before[2]?.[1]);
    // Above the floor the rebuild does its job — here, from the pruned remainder.
    expect(dimDay(1, '2026-06-10')).not.toEqual(before[2]?.[0]);
  });

  it('makes a single-day rebuild refuse, and say so', () => {
    const before = dimDay(1, '2026-06-09');
    prunePartially();

    expect(withWriteTransaction(db, () => rebuildRollupDay(db, 1, '2026-06-09'))).toBe(false);
    expect(dimDay(1, '2026-06-09')).toEqual(before);
    expect(withWriteTransaction(db, () => rebuildRollupDay(db, 1, '2026-06-10'))).toBe(true);
  });
});
