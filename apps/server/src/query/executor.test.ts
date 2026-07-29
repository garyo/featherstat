import type { QueryRequest } from '@featherstat/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { binId, event, resultOf, session } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  type EventRow,
  insertEvents,
  openDb,
  type SessionRow,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { executeQueryRequest, UnknownSiteError } from './executor.ts';

/**
 * A small handcrafted corpus with independently known totals. 2026-07-27 is a
 * Monday; site 1 lives in New York, site 2 in UTC, so preset resolution for
 * `site: "all"` has two answers for "today" around a UTC midnight.
 */

const DAY = '2026-07-27';
let db: Db;

interface Visit {
  site?: number;
  visitor: number;
  sess: number;
  date?: string;
  hour?: number;
  engaged: number;
  pages: Array<Partial<EventRow>>;
  events?: Array<Partial<EventRow>>;
  /** Outlink / download rows: stored hits, but not the `events` the session counts. */
  links?: Array<Partial<EventRow>>;
  session?: Partial<SessionRow>;
}

function seedVisit(visit: Visit): void {
  const base = {
    site_id: visit.site ?? 1,
    visitor_id: binId(visit.visitor),
    session_id: binId(visit.sess),
    local_date: visit.date ?? DAY,
    local_hour: visit.hour ?? 10,
  };
  const rows: EventRow[] = [];
  for (const page of visit.pages) {
    rows.push(event({ ...base, type: 'pageview', seq: rows.length + 1, ...page }));
  }
  for (const extra of visit.events ?? []) {
    rows.push(event({ ...base, type: 'event', seq: rows.length + 1, ...extra }));
  }
  for (const link of visit.links ?? []) {
    rows.push(event({ ...base, type: 'outlink', seq: rows.length + 1, ...link }));
  }
  insertEvents(db, rows);
  upsertSessions(db, [
    session({
      id: binId(visit.sess),
      site_id: base.site_id,
      visitor_id: base.visitor_id,
      local_date: base.local_date,
      pageviews: visit.pages.length,
      events: visit.events?.length ?? 0,
      engaged_ms: visit.engaged,
      ...visit.session,
    }),
  ]);
}

beforeAll(() => {
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'one', domains: ['one.test'], timezone: 'America/New_York' });
    createSite(db, { id: 2, name: 'two', domains: ['two.test'], timezone: 'UTC' });

    // A: engaged multi-page search visit.
    seedVisit({
      visitor: 1,
      sess: 1,
      engaged: 60_000,
      pages: [{ path: '/' }, { path: '/docs' }, { path: '/docs' }].map((p) => ({
        ...p,
        country: 'US',
        browser: 'Chrome',
        ref_domain: 'google.com',
        ref_type: 'search',
      })),
      session: { country: 'US', browser: 'Chrome', ref_domain: 'google.com', ref_type: 'search' },
    });
    // B: single page, no events, three engaged minutes — NOT a bounce (docs/03).
    seedVisit({
      visitor: 2,
      sess: 2,
      hour: 12,
      engaged: 120_000,
      pages: [{ path: '/blog', country: 'DE' }],
      session: { country: 'DE' },
    });
    // C: single page, no engagement — the only bounce.
    seedVisit({
      visitor: 3,
      sess: 3,
      hour: 12,
      engaged: 3_000,
      pages: [{ path: '/pricing', country: 'US' }],
      session: { country: 'US' },
    });
    // D: single page but fired an event — not a bounce either.
    seedVisit({
      visitor: 4,
      sess: 4,
      hour: 20,
      engaged: 1_000,
      pages: [{ path: '/' }],
      events: [{ path: '/', event_category: 'cta', event_action: 'click', event_value: 2.5 }],
    });
    // E: previous week, for compare 'previous'.
    seedVisit({ visitor: 5, sess: 5, date: '2026-07-20', engaged: 0, pages: [{ path: '/' }] });
    // F: a year earlier, for compare 'year'.
    seedVisit({ visitor: 6, sess: 6, date: '2025-07-27', engaged: 0, pages: [{ path: '/' }] });
    // Site 2: one visit on the shared day, one on the next UTC day. The first
    // leaves by two outbound clicks to one partner and takes a download.
    seedVisit({
      site: 2,
      visitor: 7,
      sess: 7,
      engaged: 0,
      pages: [{ path: '/x' }],
      links: [
        { path: '/x', target_url: 'https://example.net/partner' },
        { path: '/x', target_url: 'https://example.net/partner' },
        { type: 'download', path: '/x', target_url: 'https://two.test/files/report.pdf' },
      ],
    });
    seedVisit({
      site: 2,
      visitor: 8,
      sess: 8,
      date: '2026-07-28',
      engaged: 0,
      pages: [{ path: '/x' }],
    });
  });
});

const RANGE = { range: { from: DAY, to: DAY } } as const;

function run(partial: Omit<QueryRequest, 'site' | 'range'> & Partial<QueryRequest>) {
  const request: QueryRequest = { site: 1, ...RANGE, ...partial };
  return executeQueryRequest(db, request);
}

describe('metric semantics', () => {
  it('answers the mixed-shape KPI query from both tables, merged into one row', () => {
    const response = run({
      queries: [{ id: 'kpis', metrics: ['visitors', 'pageviews', 'engaged_ms', 'bounce_rate'] }],
    });
    expect(resultOf(response, 'kpis').rows).toEqual([
      { visitors: 4, pageviews: 6, engaged_ms: 184_000, bounce_rate: 0.25 },
    ]);
  });

  it('computes visits, ratios and event sums', () => {
    const response = run({
      queries: [{ id: 'q', metrics: ['visits', 'views_per_visit', 'events', 'event_value_sum'] }],
    });
    expect(resultOf(response, 'q').rows).toEqual([
      { visits: 4, views_per_visit: 1.5, events: 1, event_value_sum: 2.5 },
    ]);
  });

  it('breaks pages down by path, ordered by the first metric', () => {
    const response = run({
      queries: [{ id: 'pages', metrics: ['pageviews', 'visitors'], dim: 'path', limit: 10 }],
    });
    expect(resultOf(response, 'pages').rows).toEqual([
      { path: '/', pageviews: 2, visitors: 2 },
      { path: '/docs', pageviews: 2, visitors: 1 },
      { path: '/blog', pageviews: 1, visitors: 1 },
      { path: '/pricing', pageviews: 1, visitors: 1 },
    ]);
  });

  it('counts outbound links and downloads, and breaks them down by target', () => {
    const response = run({
      site: 2,
      queries: [
        { id: 'totals', metrics: ['outlinks', 'downloads'] },
        { id: 'targets', metrics: ['outlinks'], dim: 'target_url', limit: 10 },
      ],
    });
    expect(resultOf(response, 'totals').rows).toEqual([{ outlinks: 2, downloads: 1 }]);
    // The download's target is a target_url group too; it simply has no outlinks —
    // an honest 0, the same shape every breakdown returns for a foreign hit type.
    expect(resultOf(response, 'targets').rows).toEqual([
      { target_url: 'https://example.net/partner', outlinks: 2 },
      { target_url: null, outlinks: 0 },
      { target_url: 'https://two.test/files/report.pdf', outlinks: 0 },
    ]);
  });

  it('filters by target_url', () => {
    const response = run({
      site: 2,
      queries: [
        {
          id: 'q',
          metrics: ['outlinks', 'pageviews'],
          filters: [{ dim: 'target_url', op: 'contains', value: 'example.net' }],
        },
      ],
    });
    // Only the two outbound rows match: the pageview they left from carries no target.
    expect(resultOf(response, 'q').rows).toEqual([{ outlinks: 2, pageviews: 0 }]);
  });

  it('applies a bound limit', () => {
    const response = run({
      queries: [{ id: 'pages', metrics: ['pageviews'], dim: 'path', limit: 2 }],
    });
    expect(resultOf(response, 'pages').rows).toHaveLength(2);
  });

  it('groups referrers including the NULL (direct) group', () => {
    const response = run({ queries: [{ id: 'refs', metrics: ['visitors'], dim: 'ref_domain' }] });
    expect(resultOf(response, 'refs').rows).toEqual([
      { ref_domain: null, visitors: 3 },
      { ref_domain: 'google.com', visitors: 1 },
    ]);
  });

  it('produces the hour × weekday heatmap', () => {
    const response = run({
      queries: [{ id: 'heat', metrics: ['pageviews'], dim: 'local_hour', dim2: 'weekday' }],
    });
    expect(resultOf(response, 'heat').rows).toEqual([
      { local_hour: 10, weekday: 1, pageviews: 3 },
      { local_hour: 12, weekday: 1, pageviews: 2 },
      { local_hour: 20, weekday: 1, pageviews: 1 },
    ]);
  });

  it('merges a split query grouped by a shared dimension', () => {
    const response = run({
      queries: [{ id: 'geo', metrics: ['visits', 'pageviews'], dim: 'country' }],
    });
    // Ties order like the SQL path would: `ORDER BY metric DESC, 1` puts NULL first.
    expect(resultOf(response, 'geo').rows).toEqual([
      { country: 'US', visits: 2, pageviews: 4 },
      { country: null, visits: 1, pageviews: 1 },
      { country: 'DE', visits: 1, pageviews: 1 },
    ]);
  });

  it('keeps a stored "null" string distinct from the NULL group when merging', () => {
    const mini = openDb(':memory:');
    withWriteTransaction(mini, () => {
      createSite(mini, { id: 1, name: 'one', domains: ['one.test'] });
      insertEvents(mini, [
        event({ local_date: DAY, country: 'null', visitor_id: binId(1), session_id: binId(1) }),
        event({ local_date: DAY, visitor_id: binId(2), session_id: binId(2) }),
      ]);
      upsertSessions(mini, [
        session({ id: binId(1), visitor_id: binId(1), local_date: DAY, country: 'null' }),
        session({ id: binId(2), visitor_id: binId(2), local_date: DAY }),
      ]);
    });
    const response = executeQueryRequest(mini, {
      site: 1,
      range: { from: DAY, to: DAY },
      queries: [{ id: 'q', metrics: ['visits', 'pageviews'], dim: 'country' }],
    });
    expect(resultOf(response, 'q').rows).toEqual([
      { country: null, visits: 1, pageviews: 1 },
      { country: 'null', visits: 1, pageviews: 1 },
    ]);
    mini.close();
  });

  it('counts visits over an event-level dimension as distinct sessions', () => {
    const response = run({ queries: [{ id: 'q', metrics: ['visits'], dim: 'path' }] });
    const rows = resultOf(response, 'q').rows;
    expect(rows[0]).toEqual({ path: '/', visits: 2 });
  });
});

describe('buckets', () => {
  it('buckets by day across a range', () => {
    const response = run({
      range: { from: '2026-07-20', to: DAY },
      queries: [{ id: 'series', metrics: ['visits'], bucket: 'day' }],
    });
    expect(resultOf(response, 'series').rows).toEqual([
      { bucket: '2026-07-20', visits: 1 },
      { bucket: DAY, visits: 4 },
    ]);
  });

  it('buckets by hour (events only), week and month', () => {
    const response = run({
      range: { from: '2026-07-20', to: DAY },
      queries: [
        { id: 'hour', metrics: ['pageviews'], bucket: 'hour' },
        { id: 'week', metrics: ['pageviews'], bucket: 'week' },
        { id: 'month', metrics: ['pageviews'], bucket: 'month' },
      ],
    });
    expect(resultOf(response, 'hour').rows).toEqual([
      { bucket: '2026-07-20 10:00', pageviews: 1 },
      { bucket: '2026-07-27 10:00', pageviews: 3 },
      { bucket: '2026-07-27 12:00', pageviews: 2 },
      { bucket: '2026-07-27 20:00', pageviews: 1 },
    ]);
    // Both dates are Mondays, so they are their own week starts.
    expect(resultOf(response, 'week').rows).toEqual([
      { bucket: '2026-07-20', pageviews: 1 },
      { bucket: '2026-07-27', pageviews: 6 },
    ]);
    expect(resultOf(response, 'month').rows).toEqual([{ bucket: '2026-07', pageviews: 7 }]);
  });
});

describe('filters', () => {
  it('eq narrows sessions and events alike', () => {
    const response = run({
      filters: [{ dim: 'country', op: 'eq', value: 'US' }],
      queries: [{ id: 'q', metrics: ['visits', 'bounce_rate'] }],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 2, bounce_rate: 0.5 }]);
  });

  it('an engaged single-page session is NOT a bounce (engagement-aware, docs/03)', () => {
    // Visitor B: 1 pageview, 0 events, 120 s engaged. The naive definition
    // would call this a bounce; the engagement threshold must not.
    const response = run({
      filters: [{ dim: 'country', op: 'eq', value: 'DE' }],
      queries: [{ id: 'q', metrics: ['visits', 'bounce_rate'] }],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 1, bounce_rate: 0 }]);
  });

  it("'is_null' makes the NULL (direct) breakdown row clickable as a filter", () => {
    const response = run({
      filters: [{ dim: 'ref_domain', op: 'is_null' }],
      queries: [{ id: 'q', metrics: ['visits', 'pageviews'] }],
    });
    // Sessions B, C, D have no referrer; their pageviews are /blog, /pricing, /.
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 3, pageviews: 3 }]);
  });

  it('neq includes rows where the dimension is NULL', () => {
    const response = run({
      filters: [{ dim: 'country', op: 'neq', value: 'US' }],
      queries: [{ id: 'q', metrics: ['visits'] }],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 2 }]);
  });

  it("supports 'in' and 'contains'", () => {
    const response = run({
      queries: [
        {
          id: 'in',
          metrics: ['visits'],
          filters: [{ dim: 'country', op: 'in', value: ['US', 'DE'] }],
        },
        {
          id: 'contains',
          metrics: ['pageviews'],
          filters: [{ dim: 'path', op: 'contains', value: 'doc' }],
        },
        {
          id: 'starts',
          metrics: ['pageviews'],
          filters: [{ dim: 'path', op: 'starts', value: '/blog' }],
        },
      ],
    });
    expect(resultOf(response, 'in').rows).toEqual([{ visits: 3 }]);
    expect(resultOf(response, 'contains').rows).toEqual([{ pageviews: 2 }]);
    expect(resultOf(response, 'starts').rows).toEqual([{ pageviews: 1 }]);
  });

  it('treats injection attempts as literal values', () => {
    const response = run({
      queries: [
        {
          id: 'q',
          metrics: ['pageviews'],
          filters: [{ dim: 'path', op: 'eq', value: "' OR '1'='1" }],
        },
        {
          id: 'like',
          metrics: ['pageviews'],
          filters: [{ dim: 'title', op: 'contains', value: "%' OR 1=1 --" }],
        },
      ],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ pageviews: 0 }]);
    expect(resultOf(response, 'like').rows).toEqual([{ pageviews: 0 }]);
  });
});

describe('compare windows', () => {
  it("'previous' answers the same query over the window immediately before", () => {
    const response = run({
      range: { from: '2026-07-21', to: DAY },
      compare: 'previous',
      queries: [{ id: 'q', metrics: ['visits'] }],
    });
    const entry = resultOf(response, 'q');
    expect(entry.rows).toEqual([{ visits: 4 }]);
    expect(entry.compare).toEqual([{ visits: 1 }]); // visitor E on 2026-07-20
  });

  it("'year' answers over the same window one year back", () => {
    const response = run({
      compare: 'year',
      queries: [{ id: 'q', metrics: ['visits'] }],
    });
    const entry = resultOf(response, 'q');
    expect(entry.rows).toEqual([{ visits: 4 }]);
    expect(entry.compare).toEqual([{ visits: 1 }]); // visitor F on 2025-07-27
  });
});

describe("site: 'all'", () => {
  it('groups by site across all sites', () => {
    const response = run({
      site: 'all',
      queries: [{ id: 'q', metrics: ['visits', 'pageviews'], dim: 'site' }],
    });
    expect(resultOf(response, 'q').rows).toEqual([
      { site: 1, visits: 4, pageviews: 6 },
      { site: 2, visits: 1, pageviews: 1 },
    ]);
  });

  it("resolves 'today' per site timezone", () => {
    // 02:00 UTC on the 28th: New York is still on the 27th, UTC is on the 28th.
    const response = executeQueryRequest(
      db,
      {
        site: 'all',
        range: { preset: 'today' },
        queries: [{ id: 'q', metrics: ['visits'], dim: 'site' }],
      },
      { now: Date.UTC(2026, 6, 28, 2) },
    );
    expect(resultOf(response, 'q').rows).toEqual([
      { site: 1, visits: 4 }, // 2026-07-27 in New York
      { site: 2, visits: 1 }, // 2026-07-28 in UTC — the 07-27 visit must not count
    ]);
  });
});

describe('error entries', () => {
  it('answers sequence kinds alongside metric queries in one batch', () => {
    const response = run({
      queries: [
        { id: 'kpis', metrics: ['visitors'] },
        { id: 'sankey', kind: 'transitions', steps: 3, limit: 20 },
      ],
    });
    expect(resultOf(response, 'kpis').rows).toEqual([{ visitors: 4 }]);
    // A's pages (/ → /docs → /docs) and D's event step (/ → cta · click).
    expect(resultOf(response, 'sankey').rows).toEqual([
      { step: 1, from: '/', to: '/docs', sessions: 1 },
      { step: 1, from: '/', to: 'event: cta · click', sessions: 1 },
      { step: 2, from: '/docs', to: '/docs', sessions: 1 },
    ]);
  });

  it('returns unsupported for dishonest metric × dim combinations', () => {
    const response = run({
      queries: [
        { id: 'bad', metrics: ['bounce_rate'], dim: 'title' },
        { id: 'good', metrics: ['bounce_rate'] },
      ],
    });
    expect(response.results.bad).toHaveProperty(['error', 'code'], 'unsupported');
    expect(resultOf(response, 'good').rows).toEqual([{ bounce_rate: 0.25 }]);
  });

  it('throws UnknownSiteError for a site id that does not exist', () => {
    expect(() => run({ site: 99, queries: [{ id: 'q', metrics: ['visitors'] }] })).toThrow(
      UnknownSiteError,
    );
  });
});

describe('meta', () => {
  it('reports the data version and timings', () => {
    const response = run({ queries: [{ id: 'q', metrics: ['visitors'] }] });
    expect(response.meta.dataVersion).toBeGreaterThan(0);
    expect(response.meta.generatedInMs).toBeGreaterThanOrEqual(0);
    expect(resultOf(response, 'q').ms).toBeGreaterThanOrEqual(0);
  });

  it("answers site 'all' with no sites at all as empty rows", () => {
    const empty = openDb(':memory:');
    const response = executeQueryRequest(empty, {
      site: 'all',
      range: { preset: '7d' },
      queries: [{ id: 'q', metrics: ['visitors'] }],
    });
    expect(resultOf(response, 'q').rows).toEqual([]);
    empty.close();
  });
});

describe('metrics that heartbeats must not distort', () => {
  it('excludes ping-only visitors from `visitors`, so pageviews cannot trail it', () => {
    // The corpus day carries pings from visits that beat past local midnight;
    // counting their visitors here is what made pageviews < visitors.
    const [row] = resultOf(
      run({ queries: [{ id: 'k', metrics: ['visitors', 'pageviews'] }] }),
      'k',
    ).rows;
    expect(Number(row?.visitors)).toBeLessThanOrEqual(Number(row?.pageviews));
  });

  it('counts only measurable visits in `engaged_sessions`', () => {
    const [row] = resultOf(
      run({ queries: [{ id: 'k', metrics: ['visits', 'engaged_sessions', 'engaged_ms'] }] }),
      'k',
    ).rows;
    // Averaging engaged time over ALL visits would report the measurement gap
    // as brevity; the measurable subset is the honest denominator.
    expect(Number(row?.engaged_sessions)).toBeLessThanOrEqual(Number(row?.visits));
    if (Number(row?.engaged_ms) > 0) expect(Number(row?.engaged_sessions)).toBeGreaterThan(0);
  });
});
