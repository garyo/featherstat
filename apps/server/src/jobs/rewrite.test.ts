import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, openTestDb } from '../../test/rows.ts';
import {
  type Db,
  dataVersion,
  getSetting,
  insertEvents,
  stmt,
  withWriteTransaction,
} from '../db/index.ts';
import { inChunks, markRewriteDirty, oneRunAtATime, settleRewrite } from './rewrite.ts';

/** The shared plumbing of the chunked history rewrites (jobs/rewrite.ts). */

const DIRTY = 'test_rewrite:dirty';

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

afterEach(() => {
  db.close();
});

describe('oneRunAtATime', () => {
  it('lets a second caller ride the run in flight, and starts afresh once it settles', async () => {
    let runs = 0;
    const run = oneRunAtATime(async (_db: Db, label: string) => {
      runs += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return `${label}#${runs}`;
    });

    const first = run(db, 'a');
    const second = run(db, 'b');
    expect(await first).toBe('a#1');
    expect(await second).toBe('a#1');
    expect(await run(db, 'c')).toBe('c#2');
  });

  it('keeps databases apart, and a failed run does not wedge the next', async () => {
    const other = openTestDb();
    let calls = 0;
    const run = oneRunAtATime(async (_db: Db) => {
      calls += 1;
      if (calls === 1) throw new Error('first run dies');
      return calls;
    });

    await expect(run(db)).rejects.toThrow('first run dies');
    expect(await Promise.all([run(db), run(other)])).toEqual([2, 3]);
    other.close();
  });
});

describe('inChunks', () => {
  it('runs each chunk in its own write transaction until one reports done', async () => {
    const transaction = vi.spyOn(db, 'transaction');
    let chunks = 0;

    await inChunks(db, () => {
      expect(db.inTransaction).toBe(true);
      chunks += 1;
      return chunks === 3;
    });

    expect(chunks).toBe(3);
    expect(transaction).toHaveBeenCalledTimes(3);
    transaction.mockRestore();
  });
});

describe('settleRewrite', () => {
  it('owes nothing, and bumps nothing, while the flag is unset', async () => {
    const before = dataVersion(db);
    expect(await settleRewrite(db, DIRTY)).toBe(false);
    expect(dataVersion(db)).toBe(before);
  });

  it('rebuilds the rollups, bumps the epoch and clears the flag', async () => {
    withWriteTransaction(db, () => {
      insertEvents(db, [event()]);
      markRewriteDirty(db, DIRTY);
    });
    const before = dataVersion(db);

    expect(await settleRewrite(db, DIRTY)).toBe(true);

    expect(dataVersion(db)).toBeGreaterThan(before);
    expect(getSetting(db, DIRTY)).toBeUndefined();
    expect(stmt(db, 'SELECT COUNT(*) FROM rollup_dim_day').pluck().get()).toBeGreaterThan(0);
  });

  it('leaves the flag standing when the rebuild dies, so the next run pays again', async () => {
    withWriteTransaction(db, () => {
      insertEvents(db, [event()]);
      markRewriteDirty(db, DIRTY);
    });
    const before = dataVersion(db);
    db.exec(`CREATE TRIGGER crash BEFORE INSERT ON rollup_dim_day
      BEGIN SELECT RAISE(ABORT, 'crash mid-rebuild'); END`);

    await expect(settleRewrite(db, DIRTY)).rejects.toThrow('crash mid-rebuild');
    expect(getSetting(db, DIRTY)).toBe('1');
    expect(dataVersion(db)).toBe(before);

    db.exec('DROP TRIGGER crash');
    expect(await settleRewrite(db, DIRTY)).toBe(true);
    expect(dataVersion(db)).toBeGreaterThan(before);
  });
});
