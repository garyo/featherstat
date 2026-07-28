import { DAY_MS } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { binId, event, openTestDb, session } from '../../test/rows.ts';
import {
  type Db,
  insertEvents,
  setSetting,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
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

/** One event + its session, `daysAgo` old. */
function storeDay(daysAgo: number, index = daysAgo): void {
  const ts = NOW - daysAgo * DAY_MS;
  const id = binId(index);
  withWriteTransaction(db, () => {
    insertEvents(db, [{ ...event({ ts }), session_id: id }]);
    upsertSessions(db, [session({ id, started_at: ts, last_seen_at: ts })]);
  });
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
      more: false,
    });
    expect(counts()).toEqual({ events: 3, sessions: 3 });
  });

  it('deletes events and sessions older than the configured window', async () => {
    for (const daysAgo of [1, 10, 40, 100]) storeDay(daysAgo);
    setRetention('30');

    const result = await runRetention(db, { now: () => NOW });

    expect(result).toEqual({ days: 30, events: 2, sessions: 2, more: false });
    expect(counts()).toEqual({ events: 2, sessions: 2 });
    expect(db.prepare('SELECT MIN(ts) FROM events').pluck().get()).toBe(NOW - 10 * DAY_MS);
  });

  it('keeps a row exactly at the cutoff and drops the millisecond before it', async () => {
    const cutoff = NOW - 30 * DAY_MS;
    withWriteTransaction(db, () => {
      insertEvents(db, [
        { ...event({ ts: cutoff }), session_id: binId(1) },
        { ...event({ ts: cutoff - 1 }), session_id: binId(2) },
      ]);
      upsertSessions(db, [
        session({ id: binId(1), started_at: cutoff, last_seen_at: cutoff }),
        session({ id: binId(2), started_at: cutoff - 1, last_seen_at: cutoff - 1 }),
      ]);
    });
    setRetention('30');

    expect(await runRetention(db, { now: () => NOW })).toMatchObject({ events: 1, sessions: 1 });
    expect(db.prepare('SELECT ts FROM events').pluck().all()).toEqual([cutoff]);
  });

  it('keeps a session whose last hit is inside the window, however old its start', async () => {
    const started = NOW - 90 * DAY_MS;
    withWriteTransaction(db, () => {
      upsertSessions(db, [session({ id: binId(9), started_at: started, last_seen_at: NOW })]);
    });
    setRetention('30');

    expect(await runRetention(db, { now: () => NOW })).toMatchObject({ sessions: 0 });
    expect(counts().sessions).toBe(1);
  });

  it('deletes in bounded batches and reports an unfinished run', async () => {
    for (let i = 0; i < 10; i++) storeDay(100 + i, i);
    setRetention('30');

    const partial = await runRetention(db, { now: () => NOW, batchSize: 2, maxBatches: 3 });

    expect(partial).toEqual({ days: 30, events: 6, sessions: 6, more: true });
    expect(counts()).toEqual({ events: 4, sessions: 4 });

    const rest = await runRetention(db, { now: () => NOW, batchSize: 2, maxBatches: 3 });
    expect(rest).toEqual({ days: 30, events: 4, sessions: 4, more: false });
    expect(counts()).toEqual({ events: 0, sessions: 0 });
  });

  it('deletes inside a write transaction — never a bare statement', async () => {
    for (const daysAgo of [100, 200]) storeDay(daysAgo);
    setRetention('30');
    const transaction = vi.spyOn(db, 'transaction');

    await runRetention(db, { now: () => NOW, batchSize: 1 });

    // Three batches: two that delete, one that finds nothing left.
    expect(transaction).toHaveBeenCalledTimes(3);
    transaction.mockRestore();
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
