import type { HitType, QueryRequest } from '@featherstat/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { binId, event, resultOf, session, syncRollups } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  type EventRow,
  insertEvents,
  openDb,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { compileAdjacencyQuery } from './adjacency.ts';
import { executeQueryRequest } from './executor.ts';

/**
 * Handcrafted sessions around one page, `/pricing` (docs/03 § Journeys). Every
 * rule the adjacency compiler implements has a session here that would catch
 * its loss: interleaved pings, an SPA double-announce and a reload that must
 * collapse, a session that starts at the page (`(entry)`), sessions that end
 * at it (`(exit)`), and one session meeting the page twice from the SAME
 * neighbor — the distinct-session count.
 */

const DAY = '2026-07-27';
let db: Db;

interface JourneyHit {
  type?: HitType;
  path?: string;
}

interface Journey {
  sess: number;
  site?: number;
  date?: string;
  country?: string;
  hits: JourneyHit[];
}

function seedJourney(journey: Journey): void {
  const date = journey.date ?? DAY;
  const rows: EventRow[] = journey.hits.map((hit, index) =>
    event({
      site_id: journey.site ?? 1,
      visitor_id: binId(journey.sess),
      session_id: binId(journey.sess),
      local_date: date,
      local_hour: 10,
      type: hit.type ?? 'pageview',
      seq: index + 1,
      path: hit.path ?? null,
    }),
  );
  insertEvents(db, rows);
  upsertSessions(db, [
    session({
      id: binId(journey.sess),
      site_id: journey.site ?? 1,
      visitor_id: binId(journey.sess),
      local_date: date,
      pageviews: rows.filter((row) => row.type === 'pageview').length,
      country: journey.country ?? null,
    }),
  ]);
}

beforeAll(() => {
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'one', domains: ['one.test'], timezone: 'America/New_York' });
    createSite(db, { id: 2, name: 'two', domains: ['two.test'], timezone: 'UTC' });

    // A: reaches /pricing from /docs and ends there — with a ping that is not a step.
    seedJourney({
      sess: 1,
      country: 'US',
      hits: [{ path: '/' }, { type: 'ping', path: '/' }, { path: '/docs' }, { path: '/pricing' }],
    });
    // B: never meets /pricing at all.
    seedJourney({ sess: 2, country: 'US', hits: [{ path: '/' }, { path: '/docs' }] });
    // C: passes THROUGH /pricing — /docs before, /docs after.
    seedJourney({
      sess: 3,
      country: 'DE',
      hits: [{ path: '/docs' }, { path: '/pricing' }, { path: '/docs' }],
    });
    // D: starts AND ends at /pricing — the (entry) and (exit) pseudo-rows.
    seedJourney({ sess: 4, hits: [{ path: '/pricing' }] });
    // E: the SPA shape — / announced twice, /pricing reloaded — three runs, and
    // the repeats are never adjacencies.
    seedJourney({
      sess: 5,
      country: 'US',
      hits: [
        { path: '/' },
        { path: '/' },
        { path: '/pricing' },
        { path: '/pricing' },
        { path: '/docs' },
      ],
    });
    // F: meets /pricing twice from the same neighbor — one session, not two.
    seedJourney({
      sess: 6,
      country: 'DE',
      hits: [{ path: '/a' }, { path: '/pricing' }, { path: '/a' }, { path: '/pricing' }],
    });
    // G: the day before — outside the single-day range.
    seedJourney({ sess: 7, date: '2026-07-26', hits: [{ path: '/old' }, { path: '/pricing' }] });
    // Site 2: must never leak into site 1 answers.
    seedJourney({ sess: 8, site: 2, hits: [{ path: '/' }, { path: '/pricing' }] });
  });
  syncRollups(db);
});

const RANGE = { range: { from: DAY, to: DAY } } as const;

function run(partial: Omit<QueryRequest, 'site' | 'range'> & Partial<QueryRequest>) {
  const request: QueryRequest = { site: 1, ...RANGE, ...partial };
  return executeQueryRequest(db, request);
}

function adjacency(direction: 'in' | 'out', limit = 10): QueryRequest['queries'] {
  return [{ id: 'q', kind: 'adjacency', path: '/pricing', direction, limit }];
}

describe('adjacency', () => {
  it('counts what came just before the page, with (entry) for sessions starting there', () => {
    const response = run({ queries: adjacency('in') });
    expect(resultOf(response, 'q').rows).toEqual([
      // A and C arrived from /docs; E from / (its double-announce collapsed);
      // F from /a — TWICE, and still one session; D started here.
      { label: '/docs', sessions: 2 },
      { label: '(entry)', sessions: 1 },
      { label: '/', sessions: 1 },
      { label: '/a', sessions: 1 },
    ]);
  });

  it('counts what came just after, with (exit) for sessions ending there', () => {
    const response = run({ queries: adjacency('out') });
    expect(resultOf(response, 'q').rows).toEqual([
      // A ends at /pricing, D is only /pricing, F's last run is /pricing: three
      // exits. C and E went on to /docs; E's reload never reads as /pricing →
      // /pricing.
      { label: '(exit)', sessions: 3 },
      { label: '/docs', sessions: 2 },
      { label: '/a', sessions: 1 },
    ]);
  });

  it('never counts the page as its own neighbor: a repeat is one step', () => {
    for (const direction of ['in', 'out'] as const) {
      const rows = resultOf(run({ queries: adjacency(direction) }), 'q').rows;
      expect(rows.map((row) => row.label)).not.toContain('/pricing');
    }
  });

  it("guards the tail with 'limit'", () => {
    const rows = resultOf(run({ queries: adjacency('out', 1) }), 'q').rows;
    expect(rows).toEqual([{ label: '(exit)', sessions: 3 }]);
  });

  it("scopes by site, and site 'all' merges every site", () => {
    const two = run({ site: 2, queries: adjacency('in') });
    expect(resultOf(two, 'q').rows).toEqual([{ label: '/', sessions: 1 }]);

    const all = resultOf(run({ site: 'all', queries: adjacency('in') }), 'q').rows;
    // E on site 1 plus site 2's session both arrived from '/'.
    expect(all).toContainEqual({ label: '/', sessions: 2 });
    expect(all).toContainEqual({ label: '/docs', sessions: 2 });
  });

  it('scopes by the session local_date range', () => {
    const wider = run({ range: { from: '2026-07-26', to: DAY }, queries: adjacency('in') });
    expect(resultOf(wider, 'q').rows).toContainEqual({ label: '/old', sessions: 1 });
  });

  it('answers an empty range with empty rows, not an error', () => {
    const response = run({
      range: { from: '2026-01-01', to: '2026-01-02' },
      queries: adjacency('in'),
    });
    expect(resultOf(response, 'q').rows).toEqual([]);
  });
});

describe('adjacency envelope filters', () => {
  it('applies session-scoped filters', () => {
    const response = run({
      filters: [{ dim: 'country', op: 'eq', value: 'US' }],
      queries: adjacency('in'),
    });
    // Only A and E remain in scope.
    expect(resultOf(response, 'q').rows).toEqual([
      { label: '/', sessions: 1 },
      { label: '/docs', sessions: 1 },
    ]);
  });

  /** A filter the QUERY carries is the same filter (docs/04 § 3): every `kind`
   * dropped these silently, answering wider than the label it wore. */
  it('takes a filter at the query level exactly as at the request level', () => {
    const filter = { dim: 'country', op: 'eq', value: 'US' } as const;
    const unfiltered = resultOf(run({ queries: adjacency('in') }), 'q').rows;
    const viaRequest = resultOf(run({ filters: [filter], queries: adjacency('in') }), 'q').rows;
    const viaQuery = resultOf(
      run({
        queries: [
          {
            id: 'q',
            kind: 'adjacency',
            path: '/pricing',
            direction: 'in',
            limit: 10,
            filters: [filter],
          },
        ],
      }),
      'q',
    ).rows;
    expect(viaQuery).toEqual(viaRequest);
    expect(viaQuery).not.toEqual(unfiltered);
  });

  it("scope:'session' lets a visited path pick whole sessions", () => {
    const response = run({
      filters: [{ dim: 'path', op: 'eq', value: '/a', scope: 'session' }],
      queries: adjacency('in'),
    });
    // Only F visited /a; its whole journey answers.
    expect(resultOf(response, 'q').rows).toEqual([{ label: '/a', sessions: 1 }]);
  });

  it('rejects event-level hit-scope filters honestly while the batch still succeeds', () => {
    const response = run({
      filters: [{ dim: 'path', op: 'starts', value: '/docs' }],
      queries: [...adjacency('in'), { id: 'ok', metrics: ['pageviews'] }],
    });
    expect(response.results.q).toEqual({
      error: { code: 'unsupported', message: expect.stringContaining('session-scoped') },
    });
    // A's, B's, C's two, and E's closing /docs.
    expect(resultOf(response, 'ok').rows).toEqual([{ pageviews: 5 }]);
  });

  it('treats injection attempts as literal values', () => {
    const response = run({
      filters: [{ dim: 'country', op: 'eq', value: "' OR '1'='1" }],
      queries: adjacency('in'),
    });
    expect(resultOf(response, 'q').rows).toEqual([]);
  });
});

describe('adjacency compilation', () => {
  it('binds the page and the limit — never in the SQL text', () => {
    const compiled = compileAdjacencyQuery(
      { id: 'q', kind: 'adjacency', path: "'; DROP TABLE events; --", direction: 'in', limit: 10 },
      [],
      [{ siteId: 1, timezone: 'UTC', from: '2026-07-01', to: '2026-07-31' }],
    );
    if ('error' in compiled) throw new Error(compiled.error.message);
    expect(compiled.sql).not.toContain('DROP');
    expect(compiled.params).toEqual(["'; DROP TABLE events; --", 10]);
  });
});
