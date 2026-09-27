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
import { forgetPropScrubs, requestPropScrub, runPropScrubs } from './prop-scrub.ts';

let db: Db;

beforeEach(() => {
  db = openTestDb(2);
});

afterEach(() => {
  db.close();
});

const propsOf = (): (string | null)[] =>
  stmt(db, 'SELECT props FROM events ORDER BY id').pluck().all() as (string | null)[];

describe('runPropScrubs', () => {
  it('removes exactly the requested key on the requested site, and NULLs emptied bags', async () => {
    withWriteTransaction(db, () => {
      insertEvents(db, [
        event({ props: '{"other":1,"plan":"pro"}' }),
        event({ seq: 2, props: '{"plan":"free"}' }), // empties to {} → NULL
        event({ seq: 3, props: null }),
        event({ seq: 4, site_id: 2, props: '{"plan":"pro"}' }), // another site: untouched
      ]);
      requestPropScrub(db, 1, 'plan');
    });

    const result = await runPropScrubs(db);
    expect(result).toEqual({ completed: 1, rows: 2 });
    expect(propsOf()).toEqual(['{"other":1}', null, null, '{"plan":"pro"}']);
  });

  it('walks a rowid watermark in chunks and finishes across batches', async () => {
    withWriteTransaction(db, () => {
      insertEvents(
        db,
        Array.from({ length: 7 }, (_, i) => event({ seq: i + 1, props: '{"plan":"pro"}' })),
      );
      requestPropScrub(db, 1, 'plan');
    });
    const result = await runPropScrubs(db, { batchSize: 2 });
    expect(result.rows).toBe(7);
    expect(propsOf()).toEqual(Array.from({ length: 7 }, () => null));
    expect(getSetting(db, 'prop_scrub:1:plan')).toBeUndefined();
  });

  it('bounds each transaction by rows examined, however sparse the key', async () => {
    withWriteTransaction(db, () => {
      insertEvents(db, [
        ...Array.from({ length: 9 }, (_, i) => event({ seq: i + 1, props: '{"other":1}' })),
        event({ seq: 10, props: '{"plan":"pro"}' }),
      ]);
      requestPropScrub(db, 1, 'plan');
    });
    const transaction = vi.spyOn(db, 'transaction');

    expect(await runPropScrubs(db, { batchSize: 3 })).toEqual({ completed: 1, rows: 1 });

    // Windows (0,3] (3,6] (6,9] (9,12], then the one that finds the walk done.
    expect(transaction).toHaveBeenCalledTimes(5);
    transaction.mockRestore();
    expect(propsOf().at(-1)).toBeNull();
  });

  it('bumps the data epoch on completion — a history rewrite must expire every ETag', async () => {
    withWriteTransaction(db, () => {
      insertEvents(db, [event({ props: '{"plan":"pro"}' })]);
      requestPropScrub(db, 1, 'plan');
    });
    const before = dataVersion(db);
    await runPropScrubs(db);
    expect(dataVersion(db)).toBeGreaterThan(before);
  });

  it('is a no-op with nothing enqueued', async () => {
    const before = dataVersion(db);
    expect(await runPropScrubs(db)).toEqual({ completed: 0, rows: 0 });
    expect(dataVersion(db)).toBe(before);
  });
});

describe('forgetPropScrubs', () => {
  it("drops every pending scrub of the site, and none of another's", () => {
    withWriteTransaction(db, () => {
      requestPropScrub(db, 1, 'plan');
      requestPropScrub(db, 1, 'tier');
      requestPropScrub(db, 2, 'plan');
      forgetPropScrubs(db, 1);
    });
    const keys = stmt<string>(db, "SELECT key FROM settings WHERE key LIKE 'prop_scrub:%'")
      .pluck()
      .all();
    expect(keys).toEqual(['prop_scrub:2:plan']);
  });
});
