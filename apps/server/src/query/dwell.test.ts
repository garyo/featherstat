import { type HitType, PING_CLAMP_MS, type QueryRequest } from '@featherstat/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { binId, event, openTestDb, resultOf, session, T0 } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  type EventRow,
  insertEvents,
  openDb,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { compileDwellQuery, DWELL_MEASURES } from './dwell.ts';
import { executeQueryRequest } from './executor.ts';

/**
 * Handcrafted sessions with hand-computed dwell (docs/03 § Sessionization).
 * Every honesty property the kind promises has a session here that would catch
 * its loss: an unmeasurable last page, a gap past the clamp, pings that credit
 * the page they follow without renumbering it, an event before the first
 * pageview, and a session crossing midnight.
 */

const DAY = '2026-07-27';
let db: Db;

interface DwellHit {
  type?: HitType;
  path?: string;
  /** Scroll depth this hit reported, 0–100; absent is unmeasured. */
  scroll?: number;
  /** Milliseconds after the visit's first hit — the gaps ARE the fixture. */
  at: number;
  /** Local date of this one row; a session can cross midnight (docs/03). */
  date?: string;
}

interface Visit {
  sess: number;
  site?: number;
  date?: string;
  country?: string;
  hits: DwellHit[];
}

function seedVisit(visit: Visit): void {
  const date = visit.date ?? DAY;
  const rows: EventRow[] = visit.hits.map((hit, index) =>
    event({
      site_id: visit.site ?? 1,
      visitor_id: binId(visit.sess),
      session_id: binId(visit.sess),
      ts: T0 + hit.at,
      local_date: hit.date ?? date,
      local_hour: 10,
      type: hit.type ?? 'pageview',
      seq: index + 1,
      path: hit.path ?? null,
      scroll_pct: hit.scroll ?? null,
    }),
  );
  insertEvents(db, rows);
  upsertSessions(db, [
    session({
      id: binId(visit.sess),
      site_id: visit.site ?? 1,
      visitor_id: binId(visit.sess),
      local_date: date,
      pageviews: rows.filter((row) => row.type === 'pageview').length,
      country: visit.country ?? null,
    }),
  ]);
}

const SECOND = 1_000;

beforeAll(() => {
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'one', domains: ['one.test'], timezone: 'America/New_York' });
    createSite(db, { id: 2, name: 'two', domains: ['two.test'], timezone: 'UTC' });

    // A: /a is timed by its heartbeats (3 × 15 s); /b by the outlink that follows
    // it, whose own gap is unmeasurable — it is the session's last event.
    seedVisit({
      sess: 1,
      country: 'US',
      hits: [
        { path: '/a', at: 0 },
        { type: 'ping', path: '/a', at: 15 * SECOND },
        { type: 'ping', path: '/a', at: 30 * SECOND },
        { path: '/b', at: 45 * SECOND },
        { type: 'outlink', path: '/b', at: 50 * SECOND },
      ],
    });
    // B: a 120 s gap clamps to PING_CLAMP_MS; /c is the last page and unmeasurable.
    seedVisit({
      sess: 2,
      country: 'US',
      hits: [
        { path: '/a', at: 0 },
        { path: '/c', at: 120 * SECOND },
      ],
    });
    // C: one pageview and nothing after it — /solo is never timed, and must not
    // appear as a zero.
    seedVisit({ sess: 3, country: 'DE', hits: [{ path: '/solo', at: 0 }] });
    // D: a server-side event lands before the first pageview; its gap belongs to
    // no page (page_idx 0) and is dropped.
    seedVisit({
      sess: 4,
      hits: [
        { type: 'event', at: 0 },
        { path: '/d', at: 10 * SECOND },
        { type: 'ping', path: '/d', at: 20 * SECOND },
      ],
    });
    // E: crosses midnight — the session's local_date is in range, its later rows' is not.
    seedVisit({
      sess: 5,
      hits: [
        { path: '/late', at: 0 },
        { path: '/after', at: 10 * SECOND, date: '2026-07-28' },
        { type: 'ping', path: '/after', at: 40 * SECOND, date: '2026-07-28' },
      ],
    });
    // F: the day before — outside the single-day range.
    seedVisit({
      sess: 6,
      date: '2026-07-26',
      hits: [
        { path: '/old', at: 0 },
        { path: '/older', at: 5 * SECOND },
      ],
    });
    // Site 2: must never leak into site 1 answers.
    seedVisit({
      sess: 7,
      site: 2,
      hits: [
        { path: '/x', at: 0 },
        { type: 'ping', path: '/x', at: 5 * SECOND },
      ],
    });
  });
});

const RANGE = { range: { from: DAY, to: DAY } } as const;

function run(partial: Omit<QueryRequest, 'site' | 'range'> & Partial<QueryRequest>) {
  const request: QueryRequest = { site: 1, ...RANGE, ...partial };
  return executeQueryRequest(db, request);
}

function dwell(limit = 10): QueryRequest['queries'] {
  return [{ id: 'q', kind: 'dwell', limit }];
}

describe('dwell attribution', () => {
  it('credits every event — pings included — to the page it followed', () => {
    const response = run({ queries: dwell() });
    expect(resultOf(response, 'q').rows).toEqual([
      // A's 3 × 15 s and B's clamped 20 s, averaged over two measured views.
      {
        path: '/a',
        views_measured: 2,
        avg_page_ms: 32_500,
        max_page_ms: 45_000,
        views_scrolled: 0,
        avg_scroll_pct: null,
      },
      // E's second page: a 30 s gap to its ping, clamped.
      {
        path: '/after',
        views_measured: 1,
        avg_page_ms: 20_000,
        max_page_ms: 20_000,
        views_scrolled: 0,
        avg_scroll_pct: null,
      },
      {
        path: '/d',
        views_measured: 1,
        avg_page_ms: 10_000,
        max_page_ms: 10_000,
        views_scrolled: 0,
        avg_scroll_pct: null,
      },
      {
        path: '/late',
        views_measured: 1,
        avg_page_ms: 10_000,
        max_page_ms: 10_000,
        views_scrolled: 0,
        avg_scroll_pct: null,
      },
      // /b was timed only by the outlink that followed it.
      {
        path: '/b',
        views_measured: 1,
        avg_page_ms: 5_000,
        max_page_ms: 5_000,
        views_scrolled: 0,
        avg_scroll_pct: null,
      },
    ]);
  });

  it('excludes a page with no subsequent event instead of scoring it zero', () => {
    const paths = resultOf(run({ queries: dwell() }), 'q').rows.map((row) => row.path);
    expect(paths).not.toContain('/solo'); // C: the only pageview of its session
    expect(paths).not.toContain('/c'); // B: the session's last event
  });

  it('clamps a long gap at PING_CLAMP_MS', () => {
    const rows = resultOf(run({ queries: dwell() }), 'q').rows;
    // B's /a leg was 120 s of wall clock; only the clamp reached the average.
    expect(rows[0]).toEqual({
      path: '/a',
      views_measured: 2,
      avg_page_ms: (45_000 + PING_CLAMP_MS) / 2,
      max_page_ms: 45_000,
      views_scrolled: 0,
      avg_scroll_pct: null,
    });
  });

  it('binds the clamp — never inlines it', () => {
    const compiled = compileDwellQuery(
      { id: 'q', kind: 'dwell', limit: 10 },
      [],
      [{ siteId: 1, timezone: 'UTC', from: '2026-07-01', to: '2026-07-31' }],
    );
    if ('error' in compiled) throw new Error(compiled.error.message);
    expect(compiled.sql).not.toContain(String(PING_CLAMP_MS));
    expect(compiled.params).toContain(PING_CLAMP_MS);
  });

  it('ranks by average time and guards the tail with `limit`', () => {
    const rows = resultOf(run({ queries: dwell(2) }), 'q').rows;
    expect(rows.map((row) => row.path)).toEqual(['/a', '/after']);
  });

  it('scopes by site, and site "all" merges every site', () => {
    expect(resultOf(run({ site: 2, queries: dwell() }), 'q').rows).toEqual([
      {
        path: '/x',
        views_measured: 1,
        avg_page_ms: 5_000,
        max_page_ms: 5_000,
        views_scrolled: 0,
        avg_scroll_pct: null,
      },
    ]);
    const all = resultOf(run({ site: 'all', queries: dwell() }), 'q').rows;
    expect(all).toContainEqual({
      path: '/x',
      views_measured: 1,
      avg_page_ms: 5_000,
      max_page_ms: 5_000,
      views_scrolled: 0,
      avg_scroll_pct: null,
    });
    expect(all).toContainEqual({
      path: '/a',
      views_measured: 2,
      avg_page_ms: 32_500,
      max_page_ms: 45_000,
      views_scrolled: 0,
      avg_scroll_pct: null,
    });
  });

  it('scopes by the session local_date range, past midnight and back', () => {
    const wider = run({ range: { from: '2026-07-26', to: DAY }, queries: dwell(20) });
    expect(resultOf(wider, 'q').rows).toContainEqual({
      path: '/old',
      views_measured: 1,
      avg_page_ms: 5_000,
      max_page_ms: 5_000,
      views_scrolled: 0,
      avg_scroll_pct: null,
    });
  });

  it('answers an empty range with empty rows, not an error', () => {
    const response = run({ range: { from: '2026-01-01', to: '2026-01-02' }, queries: dwell() });
    expect(resultOf(response, 'q').rows).toEqual([]);
  });
});

describe('dwell envelope filters', () => {
  it('applies session-scoped filters', () => {
    const response = run({
      filters: [{ dim: 'country', op: 'eq', value: 'US' }],
      queries: dwell(),
    });
    expect(resultOf(response, 'q').rows).toEqual([
      {
        path: '/a',
        views_measured: 2,
        avg_page_ms: 32_500,
        max_page_ms: 45_000,
        views_scrolled: 0,
        avg_scroll_pct: null,
      },
      {
        path: '/b',
        views_measured: 1,
        avg_page_ms: 5_000,
        max_page_ms: 5_000,
        views_scrolled: 0,
        avg_scroll_pct: null,
      },
    ]);
  });

  it("'is_null' picks the NULL group, like the metric path", () => {
    const response = run({ filters: [{ dim: 'country', op: 'is_null' }], queries: dwell() });
    expect(resultOf(response, 'q').rows.map((row) => row.path)).toEqual(['/after', '/d', '/late']);
  });

  it('rejects event-level filters honestly while the batch still succeeds', () => {
    const response = run({
      filters: [{ dim: 'path', op: 'starts', value: '/a' }],
      queries: [...dwell(), { id: 'ok', metrics: ['pageviews'] }],
    });
    expect(response.results.q).toEqual({
      error: { code: 'unsupported', message: expect.stringContaining('session-scoped') },
    });
    expect(resultOf(response, 'ok').rows).toEqual([{ pageviews: 2 }]);
  });

  it('treats injection attempts as literal values', () => {
    const response = run({
      filters: [{ dim: 'country', op: 'eq', value: "' OR '1'='1" }],
      queries: dwell(),
    });
    expect(resultOf(response, 'q').rows).toEqual([]);
  });
});

describe('scroll depth', () => {
  const scrollDb = (): Db => {
    const fresh = openTestDb();
    const previous = db;
    db = fresh;
    try {
      withWriteTransaction(fresh, () => {
        seedVisit({
          sess: 90,
          hits: [
            { path: '/long', at: 0 },
            { path: '/long', type: 'ping', at: 15_000, scroll: 40 },
            // The visit's LAST hit — its exit ping, carrying the deepest
            // reading. `dwell` cannot see this row (no next_ts), which is
            // exactly why scroll is aggregated separately.
            { path: '/long', type: 'ping', at: 30_000, scroll: 95 },
          ],
        });
        seedVisit({
          sess: 91,
          hits: [
            { path: '/long', at: 0 },
            { path: '/long', type: 'ping', at: 15_000, scroll: 55 },
            { path: '/unread', at: 20_000 },
            { path: '/unread', type: 'ping', at: 35_000 },
          ],
        });
      });
    } finally {
      db = previous;
    }
    return fresh;
  };

  const rowsOf = (fresh: Db) =>
    resultOf(executeQueryRequest(fresh, { site: 1, ...RANGE, queries: dwell() }), 'q').rows;

  /**
   * The regression this design exists to avoid. The deepest reading of a page
   * arrives on the exit ping, which is the session's last row and has no
   * `next_ts`; aggregating scroll under the dwell CTE's filter would report 40
   * here — the second-deepest reading — silently, systematically, and always low.
   */
  it('reads the exit ping, which the dwell filter cannot see', () => {
    const row = rowsOf(scrollDb()).find((r) => r.path === '/long');
    // (95 + 55) / 2 / 100 — a rate, scaled once by the client.
    expect(row?.avg_scroll_pct).toBeCloseTo(0.75, 5);
    expect(row?.views_scrolled).toBe(2);
  });

  // A page view can be timed and still carry no reading — every imported row and
  // every shim hit is one. Averaging it in as 0 % would invent a reader who saw
  // nothing, which is the measurement gap passed off as a fact.
  it('leaves a page with no reading out of the average, not in it at zero', () => {
    const row = rowsOf(scrollDb()).find((r) => r.path === '/unread');
    expect(row?.views_measured).toBe(1);
    expect(row?.views_scrolled).toBe(0);
    expect(row?.avg_scroll_pct).toBeNull();
  });

  /**
   * Nothing ties `DWELL_MEASURES` to the SELECT's columns — they are declared in
   * one place and spelled in another, and were three and three by hand until
   * this change made them five and five.
   */
  it('declares exactly the columns it returns', () => {
    const [row] = rowsOf(scrollDb());
    const columns = Object.keys(row ?? {})
      .filter((key) => key !== 'path')
      .sort();
    expect(columns).toEqual(Object.keys(DWELL_MEASURES).sort());
  });
});
