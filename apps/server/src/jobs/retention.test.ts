import { DAY_MS, localClock } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { binId, event, openTestDb, session } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  DEFAULT_TIMEZONE,
  insertEvents,
  setSetting,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { rawHorizonTs } from '../rollup/apply.ts';
import { rebuildAllRollups, rebuildRollupDay } from '../rollup/rebuild.ts';
import { RETENTION_DAYS_KEY, retentionDays, runRetention } from './retention.ts';

/** Every test measures ages from one fixed instant. */
const NOW = Date.UTC(2026, 6, 27, 12);

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

afterEach(() => {
  db.close();
});

function setRetention(days: string): void {
  withWriteTransaction(db, () => setSetting(db, RETENTION_DAYS_KEY, days));
}

/** One event + its session at `ts`, dated in the site's timezone as ingest would. */
function storeAt(ts: number, index: number, siteId = 1, timezone = DEFAULT_TIMEZONE): string {
  const id = binId(index);
  const { date: local_date, hour: local_hour } = localClock(timezone, ts);
  withWriteTransaction(db, () => {
    insertEvents(db, [
      { ...event({ site_id: siteId, ts, local_date, local_hour }), session_id: id },
    ]);
    upsertSessions(db, [
      session({ id, site_id: siteId, started_at: ts, last_seen_at: ts, local_date, local_hour }),
    ]);
  });
  return local_date;
}

/** One event + its session, `daysAgo` old. */
function storeDay(daysAgo: number, index = daysAgo): string {
  return storeAt(NOW - daysAgo * DAY_MS, index);
}

function rollupRows(): unknown[] {
  return db.prepare('SELECT * FROM rollup_dim_day ORDER BY local_date, dim_id, dim_value').all();
}

function counts(): { events: number; sessions: number } {
  return {
    events: db.prepare('SELECT COUNT(*) FROM events').pluck().get() as number,
    sessions: db.prepare('SELECT COUNT(*) FROM sessions').pluck().get() as number,
  };
}

describe('runRetention', () => {
  it('keeps everything when the setting is absent — the default', async () => {
    for (const daysAgo of [0, 400, 4000]) storeDay(daysAgo);

    expect(await runRetention(db, { now: () => NOW })).toEqual({
      days: undefined,
      events: 0,
      sessions: 0,
      propKeys: 0,
      propDrops: 0,
      more: false,
    });
    expect(counts()).toEqual({ events: 3, sessions: 3 });
  });

  it('deletes events and sessions older than the configured window', async () => {
    for (const daysAgo of [1, 10, 40, 100]) storeDay(daysAgo);
    setRetention('30');

    const result = await runRetention(db, { now: () => NOW });

    expect(result).toEqual({
      days: 30,
      events: 2,
      sessions: 2,
      propKeys: 0,
      propDrops: 0,
      more: false,
    });
    expect(counts()).toEqual({ events: 2, sessions: 2 });
    expect(db.prepare('SELECT MIN(ts) FROM events').pluck().get()).toBe(NOW - 10 * DAY_MS);
  });

  it("prunes whole site-local days, each in its own site's timezone", async () => {
    // 02:00 UTC: still the 26th in New York, already the 27th in Tokyo.
    const cutoff = Date.UTC(2026, 5, 27, 2);
    withWriteTransaction(db, () =>
      createSite(db, { id: 2, name: 'two', domains: ['two.test'], timezone: 'Asia/Tokyo' }),
    );
    const at = [
      Date.UTC(2026, 5, 26, 0), // NY 25th, Tokyo 26th: gone for both
      Date.UTC(2026, 5, 26, 14), // NY 26th, Tokyo 26th (23:00): NY keeps it
      cutoff - 1, // older than the cutoff, but on the day it falls in for both
    ];
    for (const [i, ts] of at.entries()) {
      storeAt(ts, 10 + i);
      storeAt(ts, 20 + i, 2, 'Asia/Tokyo');
    }
    setRetention('30');

    const result = await runRetention(db, { now: () => cutoff + 30 * DAY_MS });

    expect(result).toMatchObject({ events: 3, sessions: 3, more: false });
    const kept = (siteId: number): unknown[] =>
      db.prepare('SELECT ts FROM events WHERE site_id = ? ORDER BY ts').pluck().all(siteId);
    expect(kept(1)).toEqual([at[1], at[2]]);
    expect(kept(2)).toEqual([at[2]]);
  });

  it('prunes a session with its start day, however late its last hit', async () => {
    const started = NOW - 90 * DAY_MS;
    const { date: local_date } = localClock(DEFAULT_TIMEZONE, started);
    withWriteTransaction(db, () => {
      upsertSessions(db, [
        session({ id: binId(9), started_at: started, last_seen_at: NOW, local_date }),
      ]);
    });
    setRetention('30');

    expect(await runRetention(db, { now: () => NOW })).toMatchObject({ sessions: 1 });
    expect(counts().sessions).toBe(0);
  });

  it('then a full rebuild leaves every rollup below the floor as it was', async () => {
    // A visit that began before the horizon and kept going past it: its later
    // hits are dated after the horizon, the visit (and its rollup row) before.
    const started = NOW - 40 * DAY_MS;
    const later = NOW - DAY_MS;
    const startDate = storeAt(started, 1);
    withWriteTransaction(db, () => {
      const { date: local_date, hour: local_hour } = localClock(DEFAULT_TIMEZONE, later);
      insertEvents(db, [
        { ...event({ ts: later, local_date, local_hour, seq: 2 }), session_id: binId(1) },
      ]);
      db.prepare('UPDATE sessions SET last_seen_at = ?').run(later);
    });
    await rebuildAllRollups(db, { now: () => NOW });
    const before = rollupRows();
    expect(before.length).toBeGreaterThan(0);
    setRetention('30');

    await runRetention(db, { now: () => NOW });
    await rebuildAllRollups(db, { now: () => NOW });

    expect(rollupRows()).toEqual(before);
    expect(
      db.prepare('SELECT COUNT(*) FROM rollup_dim_day WHERE local_date = ?').pluck().get(startDate),
    ).toBeGreaterThan(0);
  });

  it('deletes in bounded batches and reports an unfinished run', async () => {
    for (let i = 0; i < 10; i++) storeDay(100 + i, i);
    setRetention('30');

    const partial = await runRetention(db, { now: () => NOW, batchSize: 2, maxBatches: 3 });

    expect(partial).toEqual({
      days: 30,
      events: 6,
      sessions: 6,
      propKeys: 0,
      propDrops: 0,
      more: true,
    });
    expect(counts()).toEqual({ events: 4, sessions: 4 });

    const rest = await runRetention(db, { now: () => NOW, batchSize: 2, maxBatches: 3 });
    expect(rest).toEqual({
      days: 30,
      events: 4,
      sessions: 4,
      propKeys: 0,
      propDrops: 0,
      more: false,
    });
    expect(counts()).toEqual({ events: 0, sessions: 0 });
  });

  it('deletes inside a write transaction — never a bare statement', async () => {
    for (const daysAgo of [100, 200]) storeDay(daysAgo);
    setRetention('30');
    const transaction = vi.spyOn(db, 'transaction');

    await runRetention(db, { now: () => NOW, batchSize: 1 });

    // The raw-horizon stamp, the prop-registry prune, then three batches:
    // two that delete, one that finds nothing left.
    expect(transaction).toHaveBeenCalledTimes(5);
    transaction.mockRestore();
  });

  it('records the raw floor in rollup_meta and never lowers it', async () => {
    storeDay(100);
    setRetention('30');

    await runRetention(db, { now: () => NOW });
    expect(rawHorizonTs(db)).toBe(NOW - 30 * DAY_MS);

    // Widening retention must not retreat the floor: rows below the old
    // cutoff are already gone, whatever the setting says now.
    setRetention('60');
    await runRetention(db, { now: () => NOW });
    expect(rawHorizonTs(db)).toBe(NOW - 30 * DAY_MS);

    // Unset retention leaves the recorded floor standing for the same reason.
    withWriteTransaction(db, () => setSetting(db, RETENTION_DAYS_KEY, ''));
    await runRetention(db, { now: () => NOW });
    expect(rawHorizonTs(db)).toBe(NOW - 30 * DAY_MS);
  });

  it('ages the prop registry: stale keys, their values, and old drop counters', async () => {
    const fresh = NOW - DAY_MS;
    const stale = NOW - 60 * DAY_MS;
    withWriteTransaction(db, () => {
      db.prepare(
        'INSERT INTO prop_keys (site_id, key, first_seen, last_seen, events, distinct_values) VALUES (?, ?, ?, ?, 1, 1)',
      ).run(1, 'plan', stale, stale);
      db.prepare(
        'INSERT INTO prop_keys (site_id, key, first_seen, last_seen, events, distinct_values) VALUES (?, ?, ?, ?, 1, 1)',
      ).run(1, 'theme', stale, fresh);
      db.prepare('INSERT INTO prop_values (site_id, key, value) VALUES (?, ?, ?)').run(
        1,
        'plan',
        '"pro"',
      );
      db.prepare('INSERT INTO prop_values (site_id, key, value) VALUES (?, ?, ?)').run(
        1,
        'theme',
        '"dark"',
      );
      db.prepare(
        'INSERT INTO prop_drops (site_id, local_date, reason, count) VALUES (?, ?, ?, 1)',
      ).run(1, new Date(stale).toISOString().slice(0, 10), 'oversize');
      db.prepare(
        'INSERT INTO prop_drops (site_id, local_date, reason, count) VALUES (?, ?, ?, 1)',
      ).run(1, new Date(fresh).toISOString().slice(0, 10), 'oversize');
    });
    setRetention('30');

    const result = await runRetention(db, { now: () => NOW });

    expect(result).toMatchObject({ propKeys: 1, propDrops: 1 });
    expect(db.prepare('SELECT key FROM prop_keys').pluck().all()).toEqual(['theme']);
    expect(db.prepare('SELECT key FROM prop_values').pluck().all()).toEqual(['theme']);
    expect(db.prepare('SELECT COUNT(*) FROM prop_drops').pluck().get()).toBe(1);
  });

  it('leaves the prop registry alone while retention is unset', async () => {
    withWriteTransaction(db, () => {
      db.prepare(
        'INSERT INTO prop_keys (site_id, key, first_seen, last_seen, events, distinct_values) VALUES (?, ?, ?, ?, 1, 1)',
      ).run(1, 'plan', 0, 0);
    });

    expect(await runRetention(db, { now: () => NOW })).toMatchObject({ propKeys: 0 });
    expect(db.prepare('SELECT COUNT(*) FROM prop_keys').pluck().get()).toBe(1);
  });

  it('never touches rollup rows — outliving raw is their point', async () => {
    const date = storeDay(100);
    withWriteTransaction(db, () => rebuildRollupDay(db, 1, date));
    const before = rollupRows();
    expect(before.length).toBeGreaterThan(0);
    setRetention('30');

    expect(await runRetention(db, { now: () => NOW })).toMatchObject({ events: 1 });
    expect(counts()).toEqual({ events: 0, sessions: 0 });
    expect(rollupRows()).toEqual(before);
  });
});

describe('retentionDays', () => {
  it('reads a positive integer', () => {
    setRetention('90');
    expect(retentionDays(db)).toBe(90);
  });

  it.each(['0', '-5', '', 'forever', '30.5'])('ignores the unusable value %j', (value) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setRetention(value);

    expect(retentionDays(db)).toBeUndefined();
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});
