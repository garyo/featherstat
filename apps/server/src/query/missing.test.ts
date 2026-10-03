import type { FilterNode, QueryResponse, Range } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { missing, openTestDb, resultOf } from '../../test/rows.ts';
import { type Db, insertMissingHits, type MissingRow, withWriteTransaction } from '../db/index.ts';
import { executeQueryRequest } from './executor.ts';

const DAY = '2023-11-14';
const TS = Date.UTC(2023, 10, 14, 17);

let db: Db;

beforeEach(() => {
  db = openTestDb(2);
});

afterEach(() => {
  db.close();
});

function seed(rows: readonly Partial<MissingRow>[]): void {
  withWriteTransaction(db, () =>
    insertMissingHits(
      db,
      rows.map((row) => missing(row)),
    ),
  );
}

const linked = (path: string, ref_path: string, extra: Partial<MissingRow> = {}) => ({
  path,
  ref_type: 'referral' as const,
  ref_domain: 'blog.test',
  ref_path,
  ...extra,
});

interface Ask {
  filters?: FilterNode[];
  range?: Range;
}

function ask({ filters, range = { from: DAY, to: DAY } }: Ask = {}): QueryResponse {
  return executeQueryRequest(
    db,
    { site: 1, range, filters, queries: [{ id: 'broken', kind: 'missing', limit: 10 }] },
    { now: TS },
  );
}

const rows = (options: Ask = {}) => resultOf(ask(options), 'broken').rows;

describe('the missing kind', () => {
  it('ranks linked-to paths first, each with its commonest referring page', () => {
    seed([
      { path: '/probe' },
      { path: '/probe' },
      { path: '/probe' },
      linked('/old-post', '/links'),
      linked('/old-post', '/links'),
      linked('/old-post', '/sidebar'),
      { path: '/old-post' },
    ]);

    expect(rows()).toEqual([
      {
        path: '/old-post',
        hits: 4,
        referred: 3,
        ref_domain: 'blog.test',
        ref_path: '/links',
        last_seen: DAY,
      },
      { path: '/probe', hits: 3, referred: 0, ref_domain: null, ref_path: null, last_seen: DAY },
    ]);
  });

  it('answers only the sites and days in scope', () => {
    seed([
      { path: '/here' },
      { path: '/other-site', site_id: 2 },
      { path: '/other-day', local_date: '2023-11-13' },
    ]);

    expect(rows().map((row) => row.path)).toEqual(['/here']);
  });

  it('keeps a not-found page that never said what was asked for', () => {
    seed([{ path: null }]);

    expect(rows()).toMatchObject([{ path: null, hits: 1 }]);
  });

  it('applies a filter the hit itself can answer', () => {
    seed([linked('/a', '/x', { country: 'US' }), linked('/b', '/x', { country: 'DE' })]);

    const filtered = rows({ filters: [{ dim: 'country', op: 'eq', value: 'DE' }] });

    expect(filtered.map((row) => row.path)).toEqual(['/b']);
  });

  it('refuses a filter that needs a visit, rather than answering wider', () => {
    seed([{ path: '/a' }]);

    for (const filter of [
      { dim: 'entry_path', op: 'eq', value: '/' },
      { dim: 'path', op: 'eq', value: '/a', scope: 'session' },
      { dim: 'title', op: 'eq', value: 'Home' },
    ] as FilterNode[]) {
      expect(ask({ filters: [filter] }).results.broken, JSON.stringify(filter)).toMatchObject({
        error: { code: 'unsupported' },
      });
    }
  });

  it('trims a rolling window to the instant', () => {
    seed([
      { path: '/recent', ts: TS - 3_600_000 },
      { path: '/too-old', ts: TS - 30 * 3_600_000, local_date: '2023-11-13' },
    ]);

    expect(rows({ range: { preset: '24h' } }).map((row) => row.path)).toEqual(['/recent']);
  });
});
