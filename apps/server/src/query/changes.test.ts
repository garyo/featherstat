import type { ChangesQuery, QueryRequest, QueryResult } from '@featherstat/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { binId, resultOf, syncRollups } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  type EventRow,
  insertEvents,
  openDb,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { META_RAW_HORIZON, setRollupMeta } from '../rollup/apply.ts';
import { moversOf, summarizeChanges } from './changes.ts';
import { executeQueryRequest } from './executor.ts';

/**
 * The `changes` kind (docs/04 § 3): two seeded days with independently known
 * movers. CUR is the current window, PREV its `compare: 'previous'` window —
 * per path, PREV has /a×10 /b×1 /c×3 pageviews and CUR has /b×5 /c×3, so:
 *
 *   /a  delta −10 (fell out of the current period entirely — the union-of-keys
 *        point: a client joining two top-N lists would never see it)
 *   /b  delta +4
 *   /c  delta 0
 *   Σcur − Σprev = 8 − 14 = −6 (the share denominator)
 */

const PREV = '2026-07-26';
const CUR = '2026-07-27';
const NOW = Date.parse('2026-07-27T18:00:00Z');

let db: Db;
let nextId = 0;

/** `count` pageview hits, each its own visitor and session (plus session rows). */
function hits(date: string, count: number, over: Partial<EventRow>): void {
  const ts = Date.parse(`${date}T12:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    nextId += 1;
    const id = binId(nextId);
    insertEvents(db, [
      {
        site_id: 1,
        ts,
        local_date: date,
        local_hour: 12,
        type: 'pageview',
        visitor_id: id,
        session_id: id,
        seq: 1,
        ...over,
      },
    ]);
    upsertSessions(db, [
      {
        id,
        site_id: 1,
        visitor_id: id,
        started_at: ts,
        last_seen_at: ts,
        local_date: date,
        pageviews: 1,
        events: 0,
        engaged_ms: 0,
        country: over.country ?? null,
        ref_domain: over.ref_domain ?? null,
        utm_campaign: over.utm_campaign ?? null,
      },
    ]);
  }
}

beforeAll(() => {
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'one', domains: ['one.test'], timezone: 'UTC' });
    // The whole ledger, per dimension:
    //   path:         /a −10 · /b +4 (5−1) · /c 0 (3−3); Σcur−Σprev = 8−14 = −6
    //   ref_domain:   a.com −10 · x.com +2 (3−1) · y.com +2 (2−0) · NULL 0 —
    //                 the x/y tie breaks on higher current (3 over 2)
    //   utm_campaign: 'summer' +3 · NULL −9 (5−14) — the untagged group is a key
    //   country:      US −7 · DE +1 — the one DE row feeds the filter test
    hits(PREV, 10, { path: '/a', country: 'US', ref_domain: 'a.com' });
    hits(PREV, 1, { path: '/b', country: 'US', ref_domain: 'x.com' });
    hits(PREV, 3, { path: '/c', country: 'US' });
    hits(CUR, 3, { path: '/b', country: 'US', ref_domain: 'x.com', utm_campaign: 'summer' });
    hits(CUR, 2, { path: '/b', country: 'US', ref_domain: 'y.com' });
    hits(CUR, 2, { path: '/c', country: 'US' });
    hits(CUR, 1, { path: '/c', country: 'DE' });
  });
  syncRollups(db);
});

function changesRequest(
  over: Partial<ChangesQuery>,
  request: Partial<QueryRequest> = {},
): QueryRequest {
  return {
    site: 1,
    range: { from: CUR, to: CUR },
    compare: 'previous',
    queries: [
      { id: 'ch', kind: 'changes', metric: 'pageviews', dims: ['path'], limit: 8, ...over },
    ],
    ...request,
  };
}

function rowsOf(request: QueryRequest): QueryResult {
  return resultOf(executeQueryRequest(db, request, { now: NOW }), 'ch');
}

describe('changes kind', () => {
  it('joins the union of keys — a mover absent from the current window still ranks', () => {
    const entry = rowsOf(changesRequest({ limit: 2 }));
    // Top 2 by |delta|: /a (−10) then /b (+4); /a has NO current rows at all.
    expect(entry.rows.map((row) => [row.value, row.current, row.previous, row.delta])).toEqual([
      ['/a', 0, 10, -10],
      ['/b', 5, 1, 4],
    ]);
  });

  it('computes share against the dimension’s WHOLE net change, pre-limit', () => {
    const entry = rowsOf(changesRequest({ limit: 1 }));
    // Σcur − Σprev over path = 8 − 14 = −6; /a’s share is −10/−6 even though
    // only one row was kept.
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0]?.share).toBeCloseTo(-10 / -6, 10);
  });

  it('breaks |delta| ties by higher current', () => {
    const entry = rowsOf(changesRequest({ dims: ['ref_domain'] }));
    const tied = entry.rows.filter((row) => row.value === 'x.com' || row.value === 'y.com');
    expect(tied.map((row) => row.value)).toEqual(['x.com', 'y.com']);
    expect(tied[0]).toMatchObject({ current: 3, previous: 1, delta: 2 });
    expect(tied[1]).toMatchObject({ current: 2, previous: 0, delta: 2 });
  });

  it('keeps the NULL group as a real key with a null value', () => {
    const entry = rowsOf(changesRequest({ dims: ['utm_campaign'] }));
    const untagged = entry.rows.find((row) => row.value === null);
    // Every row without a campaign, both windows: prev 14, cur 5.
    expect(untagged).toMatchObject({ dim: 'utm_campaign', current: 5, previous: 14, delta: -9 });
    const summer = entry.rows.find((row) => row.value === 'summer');
    expect(summer).toMatchObject({ current: 3, previous: 0, delta: 3 });
  });

  it('concatenates dims in request order, each section limited on its own', () => {
    const entry = rowsOf(changesRequest({ dims: ['path', 'ref_domain'], limit: 2 }));
    expect(entry.rows.map((row) => row.dim)).toEqual(['path', 'path', 'ref_domain', 'ref_domain']);
  });

  it('applies request filters to both windows', () => {
    const entry = rowsOf(
      changesRequest({ dims: ['path'] }, { filters: [{ dim: 'country', op: 'eq', value: 'DE' }] }),
    );
    // Only the one DE row exists, on /c in the current window.
    expect(entry.rows.filter((row) => (row.delta as number) !== 0)).toEqual([
      { dim: 'path', value: '/c', current: 1, previous: 0, delta: 1, share: 1 },
    ]);
  });

  it('declares the metric’s measure — visitors wears distinct, so clients mark ~', () => {
    const entry = rowsOf(changesRequest({ metric: 'visitors' }));
    expect(entry.measures?.current).toEqual({
      unit: 'count',
      population: 'actions',
      aggregate: 'distinct',
    });
    expect(entry.measures?.delta?.aggregate).toBe('distinct');
    expect(entry.measures?.share?.aggregate).toBe('computed');
  });

  it('refuses without a compare period', () => {
    const request = changesRequest({});
    delete request.compare;
    const response = executeQueryRequest(db, request, { now: NOW });
    expect(response.results.ch).toMatchObject({
      error: { code: 'unsupported', message: expect.stringContaining('compare') },
    });
  });

  it('refuses a {segment} compare — no second window to diff against', () => {
    const response = executeQueryRequest(db, changesRequest({}, { compare: { segment: 999 } }), {
      now: NOW,
    });
    expect(response.results.ch).toMatchObject({
      error: { code: 'unsupported', message: expect.stringContaining('segment') },
    });
  });

  it('refuses honestly when a raw-needing sub-query reaches below the raw horizon', () => {
    const pruned = openDb(':memory:');
    withWriteTransaction(pruned, () => {
      createSite(pruned, { id: 1, name: 'one', domains: ['one.test'], timezone: 'UTC' });
    });
    withWriteTransaction(pruned, () =>
      setRollupMeta(pruned, META_RAW_HORIZON, String(Date.parse('2026-07-25T00:00:00Z'))),
    );
    // `visitors` over a multi-day window needs raw rows (distinct honesty),
    // and the compare window reaches below the floor — a refusal, not a crash.
    const response = executeQueryRequest(
      pruned,
      {
        site: 1,
        range: { from: '2026-07-26', to: '2026-07-27' },
        compare: 'previous',
        queries: [{ id: 'ch', kind: 'changes', metric: 'visitors', dims: ['path'], limit: 8 }],
      },
      { now: NOW },
    );
    expect(response.results.ch).toMatchObject({
      error: { code: 'unsupported', message: expect.stringContaining('pruned') },
    });
    pruned.close();
  });
});

describe('summarizeChanges', () => {
  it('phrases a rise with its drivers', () => {
    expect(
      summarizeChanges('example.org', 'visits', 1400, 1187, [
        { dim: 'path', value: '/blog/foo', delta: 212 },
        { dim: 'ref_domain', value: 'news.ycombinator.com', delta: 180 },
        { dim: 'path', value: '/quiet', delta: -40 },
      ]),
    ).toBe(
      'example.org: visits up 18% (1.2k → 1.4k) — /blog/foo (+212) and news.ycombinator.com (+180) drove it',
    );
  });

  it('phrases a fall symmetrically', () => {
    expect(
      summarizeChanges('example.org', 'visits', 800, 1000, [
        { dim: 'path', value: '/gone', delta: -150 },
      ]),
    ).toBe('example.org: visits down 20% (1k → 800) — /gone (-150) drove the drop');
  });

  it('reads a small move as steady', () => {
    expect(summarizeChanges('example.org', 'visits', 1020, 1000, [])).toBe(
      'example.org: steady (±2%)',
    );
  });

  it('names a NULL group by what its dimension means, never "(none)"', () => {
    const said = (dim: string): string =>
      summarizeChanges('s', 'visits', 200, 100, [{ dim, value: null, delta: 100 }]);
    expect(said('ref_domain')).toBe(
      's: visits up 100% (100 → 200) — direct traffic (+100) drove it',
    );
    expect(said('utm_campaign')).toBe(
      's: visits up 100% (100 → 200) — untagged traffic (+100) drove it',
    );
    expect(said('country')).toBe(
      's: visits up 100% (100 → 200) — unknown location (+100) drove it',
    );
  });

  it('skips a NULL driver its dimension cannot name, rather than saying nothing useful', () => {
    // A null path is not a story; the sentence keeps its head and drops the driver.
    expect(
      summarizeChanges('s', 'visits', 200, 100, [{ dim: 'path', value: null, delta: 100 }]),
    ).toBe('s: visits up 100% (100 → 200)');
    expect(
      summarizeChanges('s', 'visits', 200, 100, [
        { dim: 'path', value: null, delta: 100 },
        { dim: 'ref_domain', value: null, delta: 90 },
      ]),
    ).toBe('s: visits up 100% (100 → 200) — direct traffic (+90) drove it');
  });

  it('takes the second driver from another dimension — two rows of one dim are one story', () => {
    expect(
      summarizeChanges('s', 'visits', 400, 200, [
        { dim: 'path', value: '/a', delta: 120 },
        { dim: 'path', value: '/b', delta: 110 },
        { dim: 'ref_domain', value: 'news.example', delta: 60 },
      ]),
    ).toBe('s: visits up 100% (200 → 400) — /a (+120) and news.example (+60) drove it');
  });

  it('falls back to the same dimension when nothing else moved that way', () => {
    expect(
      summarizeChanges('s', 'visits', 400, 200, [
        { dim: 'path', value: '/a', delta: 120 },
        { dim: 'path', value: '/b', delta: 110 },
      ]),
    ).toBe('s: visits up 100% (200 → 400) — /a (+120) and /b (+110) drove it');
  });
});

describe('moversOf', () => {
  it("carries each row's dimension, so the summary can name its NULL group", () => {
    expect(
      moversOf([
        { dim: 'ref_domain', value: null, delta: 12 },
        { dim: 'path', value: '/a', delta: -3 },
        { dim: 'path', value: '/b', delta: 'not a number' },
      ]),
    ).toEqual([
      { dim: 'ref_domain', value: null, delta: 12 },
      { dim: 'path', value: '/a', delta: -3 },
    ]);
  });
});
