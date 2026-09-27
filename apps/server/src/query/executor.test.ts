import {
  ENGAGEMENT_THRESHOLD_MS,
  localClock,
  type QueryRequest,
  type QueryResponse,
  type SiteWindow,
} from '@featherstat/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { binId, event, resultOf, session, syncRollups } from '../../test/rows.ts';
import {
  createSegment,
  createSite,
  type Db,
  type EventRow,
  insertEvents,
  openDb,
  type SessionRow,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { META_ENGAGEMENT_THRESHOLD, META_RAW_HORIZON, setRollupMeta } from '../rollup/apply.ts';
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
        props: '{"plan":"pro"}',
      })),
      session: {
        country: 'US',
        browser: 'Chrome',
        ref_domain: 'google.com',
        ref_type: 'search',
        entry_path: '/',
        exit_path: '/docs',
      },
    });
    // B: single page, no events, three engaged minutes — NOT a bounce (docs/03).
    seedVisit({
      visitor: 2,
      sess: 2,
      hour: 12,
      engaged: 120_000,
      pages: [{ path: '/blog', country: 'DE', props: '{"plan":"free"}' }],
      session: { country: 'DE', entry_path: '/blog', exit_path: '/blog' },
    });
    // C: single page, no engagement — the only bounce.
    seedVisit({
      visitor: 3,
      sess: 3,
      hour: 12,
      engaged: 3_000,
      pages: [{ path: '/pricing', country: 'US' }],
      session: { country: 'US', entry_path: '/pricing', exit_path: '/pricing' },
    });
    // D: single page but fired an event — not a bounce either.
    seedVisit({
      visitor: 4,
      sess: 4,
      hour: 20,
      engaged: 1_000,
      pages: [{ path: '/' }],
      events: [{ path: '/', event_category: 'cta', event_action: 'click', event_value: 2.5 }],
      session: { entry_path: '/', exit_path: '/' },
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
  syncRollups(db);
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
    syncRollups(mini);
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

describe('prop:<key> dimensions end-to-end (docs/03 § Props)', () => {
  it('groups by a prop key, bag-less rows forming the NULL group', () => {
    const response = run({
      queries: [{ id: 'q', metrics: ['pageviews'], dim: 'prop:plan' }],
    });
    expect(resultOf(response, 'q').rows).toEqual([
      { 'prop:plan': 'pro', pageviews: 3 },
      { 'prop:plan': null, pageviews: 2 }, // C and D never sent a bag
      { 'prop:plan': 'free', pageviews: 1 },
    ]);
  });

  it('filters by a prop value, and is_null selects the bag-less rows', () => {
    const eq = run({
      queries: [
        {
          id: 'q',
          metrics: ['visitors', 'pageviews'],
          filters: [{ dim: 'prop:plan', op: 'eq', value: 'pro' }],
        },
      ],
    });
    expect(resultOf(eq, 'q').rows).toEqual([{ visitors: 1, pageviews: 3 }]);

    const isNull = run({
      queries: [
        { id: 'q', metrics: ['pageviews'], filters: [{ dim: 'prop:plan', op: 'is_null' }] },
      ],
    });
    expect(resultOf(isNull, 'q').rows).toEqual([{ pageviews: 2 }]);
  });

  it("scope:'session' on a prop leaf answers session metrics honestly", () => {
    const response = run({
      queries: [
        {
          id: 'q',
          metrics: ['visits', 'bounce_rate'],
          filters: [{ dim: 'prop:plan', op: 'eq', value: 'pro', scope: 'session' }],
        },
      ],
    });
    // Only visit A carried plan=pro, and it is not a bounce.
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 1, bounce_rate: 0 }]);
  });

  it('refuses session metrics under a hit-scoped prop dim, like any event-only dim', () => {
    const response = run({
      queries: [{ id: 'q', metrics: ['bounce_rate'], dim: 'prop:plan' }],
    });
    expect(response.results.q).toMatchObject({ error: { code: 'unsupported' } });
  });
});

describe('filter trees', () => {
  it("'glob' matches SQLite glob patterns against the column", () => {
    const response = run({
      queries: [
        { id: 'd', metrics: ['pageviews'], filters: [{ dim: 'path', op: 'glob', value: '/d*' }] },
        {
          id: 'one',
          metrics: ['pageviews'],
          filters: [{ dim: 'path', op: 'glob', value: '/?ricing' }],
        },
      ],
    });
    expect(resultOf(response, 'd').rows).toEqual([{ pageviews: 2 }]);
    expect(resultOf(response, 'one').rows).toEqual([{ pageviews: 1 }]);
  });

  it("'any' takes the union of its branches", () => {
    const response = run({
      filters: [
        {
          any: [
            { dim: 'country', op: 'eq', value: 'US' },
            { dim: 'country', op: 'eq', value: 'DE' },
          ],
        },
      ],
      queries: [{ id: 'q', metrics: ['visits'] }],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 3 }]);
  });

  it('not(eq) matches a NULL row exactly as neq does; not(is_null) excludes it', () => {
    const response = run({
      queries: [
        // Sessions B, C, D have no referrer: a NULL differs from google.com.
        {
          id: 'noteq',
          metrics: ['visits'],
          filters: [{ not: { dim: 'ref_domain', op: 'eq', value: 'google.com' } }],
        },
        {
          id: 'neq',
          metrics: ['visits'],
          filters: [{ dim: 'ref_domain', op: 'neq', value: 'google.com' }],
        },
        // ... and a NULL referrer IS null, so its negation excludes those rows.
        {
          id: 'notnull',
          metrics: ['visits'],
          filters: [{ not: { dim: 'ref_domain', op: 'is_null' } }],
        },
      ],
    });
    expect(resultOf(response, 'noteq').rows).toEqual([{ visits: 3 }]);
    expect(resultOf(response, 'neq').rows).toEqual(resultOf(response, 'noteq').rows);
    expect(resultOf(response, 'notnull').rows).toEqual([{ visits: 1 }]);
  });

  it('negation stays NULL-safe over a whole subtree', () => {
    // D's country is NULL: `any` evaluates to NULL for it, and only the
    // COALESCE lets its negation claim the row. B (DE) matches too.
    const response = run({
      filters: [
        {
          not: {
            any: [
              { dim: 'country', op: 'eq', value: 'US' },
              { dim: 'country', op: 'is_null' },
            ],
          },
        },
      ],
      queries: [{ id: 'q', metrics: ['visits'] }],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 1 }]);
  });

  it("scope:'session' answers both tables: the session that visited the path", () => {
    // Only session A visited /docs. Session metrics count that one visit; the
    // event metric counts ALL of A's pageviews (/ included), not just the match.
    const response = run({
      filters: [{ dim: 'path', op: 'eq', value: '/docs', scope: 'session' }],
      queries: [{ id: 'q', metrics: ['visits', 'bounce_rate', 'pageviews'] }],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 1, bounce_rate: 0, pageviews: 3 }]);
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
    // A's pages (/ → /docs → /docs, one move once the repeat collapses) and
    // D's event step (/ → cta · click).
    expect(resultOf(response, 'sankey').rows).toEqual([
      { step: 1, from: '/', to: '/docs', sessions: 1 },
      { step: 1, from: '/', to: 'event: cta · click', sessions: 1 },
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

describe('session-only dimensions (entry_path, exit_path)', () => {
  it('breaks visits down by entry page, with the measures header unchanged in shape', () => {
    const response = run({
      queries: [{ id: 'q', metrics: ['visits'], dim: 'entry_path', limit: 10 }],
    });
    const result = resultOf(response, 'q');
    expect(result.rows).toEqual([
      { entry_path: '/', visits: 2 }, // A and D
      { entry_path: '/blog', visits: 1 },
      { entry_path: '/pricing', visits: 1 },
    ]);
    expect(result.measures).toEqual({
      visits: { unit: 'count', population: 'sessions', aggregate: 'sum' },
    });
  });

  it('refuses pageviews × entry_path honestly while the batch still succeeds', () => {
    const response = run({
      queries: [
        { id: 'bad', metrics: ['pageviews'], dim: 'entry_path' },
        { id: 'good', metrics: ['pageviews'] },
      ],
    });
    expect(response.results.bad).toEqual({
      error: {
        code: 'unsupported',
        message: expect.stringContaining("session-level 'entry_path'"),
      },
    });
    expect(resultOf(response, 'good').rows).toEqual([{ pageviews: 6 }]);
  });

  it('filters session metrics by entry page', () => {
    const response = run({
      filters: [{ dim: 'entry_path', op: 'eq', value: '/' }],
      queries: [{ id: 'q', metrics: ['visits', 'engaged_ms'] }],
    });
    // A (60 s) and D (1 s) entered at '/'.
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 2, engaged_ms: 61_000 }]);
  });

  it("scope:'session' lets an entry page narrow an event metric", () => {
    const response = run({
      filters: [{ dim: 'entry_path', op: 'eq', value: '/', scope: 'session' }],
      queries: [{ id: 'q', metrics: ['pageviews'] }],
    });
    // Every page view of the sessions that entered at '/': A's 3 and D's 1.
    expect(resultOf(response, 'q').rows).toEqual([{ pageviews: 4 }]);
  });

  it('treats an injection attempt in an entry_path filter as a literal value', () => {
    const response = run({
      filters: [{ dim: 'entry_path', op: 'eq', value: "'; DELETE FROM sessions; --" }],
      queries: [{ id: 'q', metrics: ['visits'] }],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 0 }]);
  });
});

/**
 * The response describes itself (docs/04 § 3): it states the window it resolved
 * and the axis it enumerated, so no client re-derives either. `site: 'all'` is
 * the case that forces `windows` to be an ARRAY — site 1 is in New York and
 * site 2 in UTC, so around a UTC midnight there is no single window for the batch.
 */
describe('windows and axes', () => {
  /** 02:00 UTC on the 28th: New York is still on the 27th. */
  const MIDNIGHT_GAP = Date.UTC(2026, 6, 28, 2);

  it('states the window it resolved, with the zone it resolved in', () => {
    const response = run({ queries: [{ id: 'q', metrics: ['visitors'] }] });
    expect(response.meta.windows).toEqual([
      { siteId: 1, timezone: 'America/New_York', from: DAY, to: DAY },
    ]);
  });

  it("carries one window per site under 'all', because their timezones differ", () => {
    const response = executeQueryRequest(
      db,
      {
        site: 'all',
        range: { preset: 'today' },
        queries: [{ id: 'series', metrics: ['visitors'], bucket: 'day', dim: 'site' }],
      },
      { now: MIDNIGHT_GAP },
    );
    expect(response.meta.windows).toEqual([
      { siteId: 1, timezone: 'America/New_York', from: '2026-07-27', to: '2026-07-27' },
      { siteId: 2, timezone: 'UTC', from: '2026-07-28', to: '2026-07-28' },
    ]);
    // And one axis per site — collapsing these would put every card on one
    // site's clock and zero the others for the hours around a midnight.
    expect(resultOf(response, 'series').axis).toEqual([
      { siteId: 1, keys: ['2026-07-27'], clip: '2026-07-27' },
      { siteId: 2, keys: ['2026-07-28'], clip: '2026-07-28' },
    ]);
  });

  it('enumerates the axis a bucketed result was computed on, and names its granularity', () => {
    const response = run({
      range: { from: '2026-07-25', to: '2026-07-28' },
      queries: [{ id: 'series', metrics: ['visits'], bucket: 'day' }],
    });
    const entry = resultOf(response, 'series');
    expect(entry.bucket).toBe('day');
    expect(entry.axis).toEqual([
      {
        siteId: 1,
        keys: ['2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28'],
        clip: '2026-07-28',
      },
    ]);
    // Rows stay SPARSE: four keys on the axis, one row. The client zips.
    expect(entry.rows).toEqual([{ bucket: '2026-07-27', visits: 4 }]);
  });

  it('runs a `today` hour axis to the end of the local day and clips at the hour in progress', () => {
    const response = executeQueryRequest(
      db,
      {
        site: 2,
        range: { preset: 'today' },
        queries: [{ id: 'hours', metrics: ['pageviews'], bucket: 'hour' }],
      },
      { now: MIDNIGHT_GAP },
    );
    const [axis] = resultOf(response, 'hours').axis ?? [];
    expect(axis?.keys).toHaveLength(24);
    expect(axis?.clip).toBe('2026-07-28 02:00');
  });

  it('leaves an unbucketed result without a bucket or an axis', () => {
    const entry = resultOf(run({ queries: [{ id: 'q', metrics: ['visitors'] }] }), 'q');
    expect(entry.bucket).toBeUndefined();
    expect(entry.axis).toBeUndefined();
  });

  it('withholds the axis for a genuine 2-D result: rows stay sparse, never a cross product', () => {
    // `pages~<id>` is deliberately unlimited (packages/shared widgets.ts), so an
    // axis here would invite a dense fill of path × day.
    const entry = resultOf(
      run({ queries: [{ id: 'pages', metrics: ['pageviews'], dim: 'path', bucket: 'day' }] }),
      'pages',
    );
    expect(entry.bucket).toBe('day');
    expect(entry.axis).toBeUndefined();
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

  it('excludes heartbeat-only visits from `visits` under an event-level dimension', () => {
    // A visit that only beat on a page has a row in that page's group but did
    // nothing there. Counting it while its visitor is not counted would put two
    // different populations in one row: a visit with no visitor and no action.
    const mini = openDb(':memory:');
    withWriteTransaction(mini, () => {
      createSite(mini, { id: 1, name: 'one', domains: ['one.test'] });
      insertEvents(mini, [
        event({ local_date: DAY, path: '/read', visitor_id: binId(1), session_id: binId(1) }),
        event({
          local_date: DAY,
          path: '/beat',
          type: 'ping',
          visitor_id: binId(2),
          session_id: binId(2),
        }),
      ]);
    });
    syncRollups(mini);
    const response = executeQueryRequest(mini, {
      site: 1,
      range: { from: DAY, to: DAY },
      queries: [{ id: 'q', metrics: ['visits', 'visitors', 'pageviews'], dim: 'path' }],
    });
    expect(resultOf(response, 'q').rows).toEqual([
      { path: '/read', visits: 1, visitors: 1, pageviews: 1 },
      { path: '/beat', visits: 0, visitors: 0, pageviews: 0 },
    ]);
    mini.close();
  });

  it('answers `engaged_sessions` with 0, not null, when nothing matched', () => {
    // It counts a subset of visits. An empty subset is none of them, not unknown
    // — only the ratio metrics are entitled to say "no answer" (docs/04).
    const response = run({
      queries: [
        {
          id: 'q',
          metrics: ['visits', 'engaged_sessions'],
          filters: [{ dim: 'country', op: 'eq', value: 'ZZ' }],
        },
      ],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ visits: 0, engaged_sessions: 0 }]);
  });
});

/**
 * The rolling `24h` preset is the only window whose edges fall INSIDE a local
 * date, and the only reason the bounds CTE carries instants at all (compiler.ts).
 * What that buys is exactly the case below: an hour whose local DATE is inside
 * the window but whose clock time is not.
 *
 * It is also the preset whose comparison is like-for-like by construction — the
 * preceding 24 hours is the same shape of window, so nothing is clipped.
 */
describe("the rolling '24h' window", () => {
  const ZONE = 'America/New_York';
  /** 2026-07-28 10:30 EDT → the window is [Jul 27 11:00, Jul 28 11:00). */
  const AT = Date.parse('2026-07-28T14:30:00Z');
  let rolling: Db;

  /** A one-hit visit at a known instant, with the two local columns ingest would compute. */
  function seedHit(visitor: number, at: number): void {
    const clock = localClock(ZONE, at);
    insertEvents(rolling, [
      event({
        ts: at,
        local_date: clock.date,
        local_hour: clock.hour,
        visitor_id: binId(visitor),
        session_id: binId(visitor),
      }),
    ]);
    upsertSessions(rolling, [
      session({
        id: binId(visitor),
        visitor_id: binId(visitor),
        started_at: at,
        last_seen_at: at,
        local_date: clock.date,
      }),
    ]);
  }

  beforeAll(() => {
    rolling = openDb(':memory:');
    withWriteTransaction(rolling, () => {
      createSite(rolling, { id: 1, name: 'one', domains: ['one.test'], timezone: ZONE });
      seedHit(1, Date.parse('2026-07-28T13:30:00Z')); // 09:30 today — inside
      seedHit(2, Date.parse('2026-07-27T16:30:00Z')); // 12:30 yesterday — inside
      seedHit(3, Date.parse('2026-07-27T13:30:00Z')); // 09:30 yesterday — before the edge
      seedHit(4, Date.parse('2026-07-26T20:00:00Z')); // 16:00 two days back — compare side
    });
    syncRollups(rolling);
  });

  const ask = (compare?: 'previous'): QueryResponse =>
    executeQueryRequest(
      rolling,
      {
        site: 1,
        range: { preset: '24h' },
        ...(compare === undefined ? {} : { compare }),
        queries: [
          { id: 'kpis', metrics: ['visitors', 'visits'] },
          { id: 'series', metrics: ['visitors'], bucket: 'hour' },
        ],
      },
      { now: AT },
    );

  it('excludes an hour the date bound alone would have let in', () => {
    // Visitor 3 hit at 09:30 yesterday: inside `from`..`to` as DATES, two hours
    // before the window opens. A date-granular bound counts it; this must not.
    expect(resultOf(ask(), 'kpis').rows).toEqual([{ visitors: 2, visits: 2 }]);
  });

  it('states an axis of 24 hour buckets crossing local midnight', () => {
    const axis = resultOf(ask(), 'series').axis?.[0];
    expect(axis?.keys).toHaveLength(24);
    expect(axis?.keys[0]).toBe('2026-07-27 11:00');
    expect(axis?.keys.at(-1)).toBe('2026-07-28 10:00');
    expect(axis?.clip).toBe('2026-07-28 10:00');
    // Rows stay sparse: the axis is the key list, never a promise of a row each.
    expect(resultOf(ask(), 'series').rows).toEqual([
      { bucket: '2026-07-27 12:00', visitors: 1 },
      { bucket: '2026-07-28 09:00', visitors: 1 },
    ]);
  });

  it('compares against the preceding 24 hours, hour for hour', () => {
    // [Jul 26 11:00, Jul 27 11:00): visitor 4 at 16:00 on the 26th, and visitor
    // 3 — the hit the current window is two hours too late for.
    expect(resultOf(ask('previous'), 'kpis').compare).toEqual([{ visitors: 2, visits: 2 }]);
  });

  it('resolves the same window for a whole hour, then rolls', () => {
    const windowAt = (at: number): SiteWindow | undefined =>
      executeQueryRequest(
        rolling,
        { site: 1, range: { preset: '24h' }, queries: [{ id: 'k', metrics: ['visitors'] }] },
        { now: at },
      ).meta.windows[0];
    expect(windowAt(AT + 29 * 60_000)).toEqual(windowAt(AT));
    expect(windowAt(AT + 3_600_000)).not.toEqual(windowAt(AT));
  });
});

/**
 * Invariant 5 on the read side: `rollup_sessions_day.bounced` bakes in the
 * threshold it was built under. A deploy that changes ENGAGEMENT_THRESHOLD_MS
 * leaves `needs_rebuild` unset until the first flush notices — reads before
 * then must already refuse the stale rollups and answer bounce from raw rows.
 */
describe('a changed engagement threshold on the read path', () => {
  let stale: Db;
  const D = '2026-07-27';

  beforeAll(() => {
    stale = openDb(':memory:');
    withWriteTransaction(stale, () => {
      createSite(stale, { id: 1, name: 'one', domains: ['one.test'], timezone: 'UTC' });
      const ts = Date.parse(`${D}T12:00:00Z`);
      insertEvents(stale, [event({ ts, local_date: D })]);
      upsertSessions(stale, [session({ started_at: ts, last_seen_at: ts, local_date: D })]);
    });
    syncRollups(stale);
    // A rollup that disagrees with raw — as one built under another threshold would.
    withWriteTransaction(stale, () =>
      stale.prepare('UPDATE rollup_sessions_day SET bounced = 0').run(),
    );
  });

  const bounce = (): unknown =>
    resultOf(
      executeQueryRequest(stale, {
        site: 1,
        range: { from: D, to: D },
        queries: [{ id: 'q', metrics: ['bounce_rate'] }],
      }),
      'q',
    ).rows[0]?.bounce_rate;

  it('answers bounce from raw rows while the stored threshold differs from the code', () => {
    withWriteTransaction(stale, () =>
      setRollupMeta(stale, META_ENGAGEMENT_THRESHOLD, String(ENGAGEMENT_THRESHOLD_MS + 1)),
    );
    expect(bounce()).toBe(1); // the one raw session is a bounce
    // The guard has teeth: under the matching threshold the rollup answers.
    withWriteTransaction(stale, () =>
      setRollupMeta(stale, META_ENGAGEMENT_THRESHOLD, String(ENGAGEMENT_THRESHOLD_MS)),
    );
    expect(bounce()).toBe(0);
  });
});

/**
 * `scope: 'session'` asks about the whole session (docs/04 § 3), on both
 * tables. A session crossing a window edge — here, visits that run over local
 * midnight, as imported history can — must not be counted by the sessions
 * table while the events table drops its pageviews because the matching hit
 * fell outside the window.
 */
describe('session scope at a window edge', () => {
  const D = '2026-07-27';
  let edge: Db;

  function seedHits(sess: number, hits: ReadonlyArray<{ at: string; path: string }>): void {
    const rows = hits.map(({ at, path }, i) => {
      const ts = Date.parse(at);
      const clock = localClock('UTC', ts);
      return event({
        ts,
        local_date: clock.date,
        local_hour: clock.hour,
        path,
        visitor_id: binId(sess),
        session_id: binId(sess),
        seq: i + 1,
      });
    });
    const first = rows[0];
    if (first === undefined) return;
    insertEvents(edge, rows);
    upsertSessions(edge, [
      session({
        id: binId(sess),
        visitor_id: binId(sess),
        started_at: first.ts,
        last_seen_at: rows[rows.length - 1]?.ts ?? first.ts,
        local_date: first.local_date,
        pageviews: rows.length,
        entry_path: first.path ?? null,
      }),
    ]);
  }

  beforeAll(() => {
    edge = openDb(':memory:');
    withWriteTransaction(edge, () => {
      createSite(edge, { id: 1, name: 'one', domains: ['one.test'], timezone: 'UTC' });
      // Starts inside the window; its /pricing hit lands after it closes.
      seedHits(1, [
        { at: `${D}T23:50:00Z`, path: '/a' },
        { at: `${D}T23:55:00Z`, path: '/b' },
        { at: '2026-07-28T00:05:00Z', path: '/pricing' },
      ]);
      // Starts (at /pricing) before the window and reaches into it.
      seedHits(2, [
        { at: '2026-07-26T23:55:00Z', path: '/pricing' },
        { at: `${D}T00:03:00Z`, path: '/c' },
      ]);
      // Wholly inside, never at /pricing.
      seedHits(3, [{ at: `${D}T12:00:00Z`, path: '/a' }]);
    });
    syncRollups(edge);
  });

  const ask = (filter: QueryRequest['filters'], metrics: ('visits' | 'pageviews')[]) =>
    resultOf(
      executeQueryRequest(edge, {
        site: 1,
        range: { from: D, to: D },
        filters: filter,
        queries: [{ id: 'q', metrics }],
      }),
      'q',
    ).rows;

  it('counts the in-window pageviews of every session with a match anywhere', () => {
    const pricing = [{ dim: 'path', op: 'eq', value: '/pricing', scope: 'session' }] as const;
    // Visits: session 1 (started in the window). Pageviews: session 1's /a and
    // /b, and session 2's /c — each session's match lies outside the window.
    expect(ask([...pricing], ['visits', 'pageviews'])).toEqual([{ visits: 1, pageviews: 3 }]);
  });

  it('reads a session-only attribute of a session that started before the window', () => {
    const entered = [{ dim: 'entry_path', op: 'eq', value: '/pricing', scope: 'session' }] as const;
    expect(ask([...entered], ['pageviews'])).toEqual([{ pageviews: 1 }]);
  });
});

describe('custom compare — {from, to}', () => {
  it('answers the comparison over the explicit window, used as given', () => {
    const response = run({
      compare: { from: '2026-07-20', to: '2026-07-20' },
      queries: [{ id: 'q', metrics: ['visits'] }],
    });
    const entry = resultOf(response, 'q');
    expect(entry.rows).toEqual([{ visits: 4 }]);
    expect(entry.compare).toEqual([{ visits: 1 }]); // visitor E on 2026-07-20
  });

  it('labels the compare window in meta.windows — the unequal-length contract', () => {
    // One current day against a two-day compare window: the result is still
    // emitted (index-aligned from the start), and the label says what ran.
    const response = run({
      compare: { from: '2026-07-19', to: '2026-07-20' },
      queries: [{ id: 'q', metrics: ['visits'], bucket: 'day' }],
    });
    const entry = resultOf(response, 'q');
    expect(entry.rows).toEqual([{ bucket: DAY, visits: 4 }]);
    expect(entry.compare).toEqual([{ bucket: '2026-07-20', visits: 1 }]);
    for (const window of response.meta.windows) {
      expect(window.compareFrom).toBe('2026-07-19');
      expect(window.compareTo).toBe('2026-07-20');
    }
  });

  it('does not label preset compares — the field means "custom"', () => {
    const response = run({ compare: 'previous', queries: [{ id: 'q', metrics: ['visits'] }] });
    for (const window of response.meta.windows) {
      expect(window.compareFrom).toBeUndefined();
      expect(window.compareTo).toBeUndefined();
    }
  });
});

describe('segment compare — {segment: id}', () => {
  let segmentId: number;
  beforeAll(() => {
    withWriteTransaction(db, () => {
      segmentId = createSegment(
        db,
        'US traffic',
        JSON.stringify({ dim: 'country', op: 'eq', value: 'US' }),
        1,
      ).id;
    });
  });

  it('equals the same query with the segment filter applied inline', () => {
    const compared = run({
      compare: { segment: segmentId },
      queries: [{ id: 'q', metrics: ['visits', 'pageviews'] }],
    });
    const manual = run({
      filters: [{ dim: 'country', op: 'eq', value: 'US' }],
      queries: [{ id: 'q', metrics: ['visits', 'pageviews'] }],
    });
    const entry = resultOf(compared, 'q');
    expect(entry.rows).toEqual([{ visits: 4, pageviews: 6 }]); // the unfiltered answer
    expect(entry.compare).toEqual(resultOf(manual, 'q').rows);
  });

  it('ANDs the segment tree beside the request filters', () => {
    const compared = run({
      compare: { segment: segmentId },
      filters: [{ dim: 'browser', op: 'eq', value: 'Chrome' }],
      queries: [{ id: 'q', metrics: ['visits'] }],
    });
    const entry = resultOf(compared, 'q');
    expect(entry.rows).toEqual([{ visits: 1 }]); // Chrome: visit A only
    expect(entry.compare).toEqual([{ visits: 1 }]); // Chrome AND US: still A
  });

  it('omits the comparison when the segment vanished under the request (the race)', () => {
    const response = run({
      compare: { segment: 9999 },
      queries: [{ id: 'q', metrics: ['visits'] }],
    });
    const entry = resultOf(response, 'q');
    expect(entry.rows).toEqual([{ visits: 4 }]);
    expect(entry.compare).toBeUndefined();
  });
});

describe('derived metrics — d:<name>', () => {
  const derived = {
    events_per_visit: 'events / visits',
    views_per_visitor: 'pageviews / visitors',
    engagement_score: '(engaged_ms / 1000 + events * 10) / visits',
  };
  const ask = (partial: Omit<QueryRequest, 'site' | 'range'> & Partial<QueryRequest>) =>
    executeQueryRequest(db, { site: 1, ...RANGE, ...partial }, { derived });

  it('computes the expression from the underlying aggregates — hand math', () => {
    // events = 1, visits = 4 over the seeded day.
    const response = ask({ queries: [{ id: 'q', metrics: ['d:events_per_visit'] }] });
    expect(resultOf(response, 'q').rows).toEqual([
      { events: 1, visits: 4, 'd:events_per_visit': 0.25 },
    ]);
  });

  it('computes per row of a breakdown, beside requested built-ins', () => {
    const response = ask({
      queries: [{ id: 'q', metrics: ['pageviews', 'd:events_per_visit'], dim: 'path', limit: 10 }],
    });
    for (const row of resultOf(response, 'q').rows) {
      const events = row.events as number;
      const visits = row.visits as number;
      expect(row['d:events_per_visit']).toBe(visits === 0 ? null : events / visits);
    }
  });

  it('declares A/B over sums as a proper ratio with both components named', () => {
    const response = ask({ queries: [{ id: 'q', metrics: ['d:events_per_visit'] }] });
    expect(resultOf(response, 'q').measures?.['d:events_per_visit']).toEqual({
      unit: 'value',
      population: 'events',
      aggregate: 'ratio',
      of: { numerator: 'events', denominator: 'visits' },
    });
  });

  it("declares any other shape as 'computed' — no client-side total exists", () => {
    const response = ask({ queries: [{ id: 'q', metrics: ['d:engagement_score'] }] });
    const measure = resultOf(response, 'q').measures?.['d:engagement_score'];
    expect(measure?.aggregate).toBe('computed');
    expect(measure?.of).toBeUndefined();
    // Hand math: (184000/1000 + 1*10) / 4 = 48.5.
    expect(resultOf(response, 'q').rows[0]?.['d:engagement_score']).toBe(48.5);
  });

  it('computes over compare rows too', () => {
    const response = ask({
      compare: 'year',
      queries: [{ id: 'q', metrics: ['d:events_per_visit'] }],
    });
    expect(resultOf(response, 'q').compare).toEqual([
      { events: 0, visits: 1, 'd:events_per_visit': 0 },
    ]);
  });

  it("refuses a distinct operand at buckets other than 'day' — never sum a distinct", () => {
    const refused = ask({
      queries: [{ id: 'q', metrics: ['d:views_per_visitor'], bucket: 'month' }],
    });
    expect(refused.results.q).toHaveProperty(['error', 'code'], 'unsupported');
    const daily = ask({
      queries: [{ id: 'q', metrics: ['d:views_per_visitor'], bucket: 'day' }],
    });
    expect(resultOf(daily, 'q').rows).toEqual([
      { bucket: DAY, pageviews: 6, visitors: 4, 'd:views_per_visitor': 1.5 },
    ]);
    const total = ask({ queries: [{ id: 'q', metrics: ['d:views_per_visitor'] }] });
    expect(resultOf(total, 'q').rows).toEqual([
      { pageviews: 6, visitors: 4, 'd:views_per_visitor': 1.5 },
    ]);
  });

  it('answers an unknown name with an honest per-query error', () => {
    const response = ask({ queries: [{ id: 'q', metrics: ['d:nope'] }] });
    expect(response.results.q).toEqual({
      error: { code: 'unsupported', message: "unknown derived metric 'd:nope'" },
    });
  });

  it('fails closed on a stored expression that no longer parses', () => {
    const response = executeQueryRequest(
      db,
      { site: 1, ...RANGE, queries: [{ id: 'q', metrics: ['d:broken'] }] },
      { derived: { broken: 'visits +' } },
    );
    expect(response.results.q).toHaveProperty(['error', 'code'], 'unsupported');
  });

  it('refuses when the component set outgrows the per-query metric ceiling', () => {
    const wide = {
      wide: 'visitors + visits + pageviews + events + outlinks + downloads + engaged_ms',
    };
    const response = executeQueryRequest(
      db,
      {
        site: 1,
        ...RANGE,
        queries: [
          { id: 'q', metrics: ['engaged_sessions', 'avg_engagement', 'bounce_rate', 'd:wide'] },
        ],
      },
      { derived: wide },
    );
    expect(response.results.q).toHaveProperty(['error', 'code'], 'unsupported');
  });
});

/**
 * The raw floor (docs/03 § Rollups): once retention records `raw_horizon_ts`,
 * a question only raw rows can answer refuses a window that reaches it —
 * partial numbers are wrong numbers — while rollup-answerable shapes keep
 * answering below it, which is the point of rollups outliving raw.
 */
describe('the retention raw horizon', () => {
  let pruned: Db;
  const OLD = '2026-05-01';
  /** Above the horizon by more than a local day everywhere. */
  const RECENT = '2026-07-20';

  function seedDay(date: string, n: number): void {
    const ts = Date.parse(`${date}T12:00:00Z`);
    insertEvents(pruned, [
      event({ ts, local_date: date, visitor_id: binId(n), session_id: binId(n) }),
    ]);
    upsertSessions(pruned, [
      session({
        id: binId(n),
        visitor_id: binId(n),
        started_at: ts,
        last_seen_at: ts,
        local_date: date,
      }),
    ]);
  }

  beforeAll(() => {
    pruned = openDb(':memory:');
    withWriteTransaction(pruned, () => {
      createSite(pruned, { id: 1, name: 'one', domains: ['one.test'] });
      seedDay(OLD, 1);
      seedDay(RECENT, 2);
    });
    syncRollups(pruned);
    // Retention would record this after pruning to 2026-06-01.
    withWriteTransaction(pruned, () =>
      setRollupMeta(pruned, META_RAW_HORIZON, String(Date.parse('2026-06-01T00:00:00Z'))),
    );
  });

  const SPAN = { range: { from: OLD, to: RECENT } } as const;

  it('refuses a raw-only metric shape whose window reaches below the floor', () => {
    const response = executeQueryRequest(pruned, {
      site: 1,
      ...SPAN,
      queries: [{ id: 'q', metrics: ['pageviews'], dim: 'title' }],
    });
    expect(response.results.q).toMatchObject({
      error: { code: 'unsupported', message: expect.stringContaining('pruned') },
    });
  });

  it('refuses the raw-walking kinds below the floor too — never partial journeys', () => {
    const response = executeQueryRequest(pruned, {
      site: 1,
      ...SPAN,
      queries: [{ id: 'j', kind: 'transitions', steps: 3, limit: 20 }],
    });
    expect(response.results.j).toMatchObject({
      error: { code: 'unsupported', message: expect.stringContaining('pruned') },
    });
  });

  it('keeps answering rollup-routed shapes below the floor — their whole point', () => {
    const response = executeQueryRequest(pruned, {
      site: 1,
      ...SPAN,
      queries: [{ id: 'q', metrics: ['pageviews'], dim: 'path', bucket: 'day' }],
    });
    // Both days answer, including the one whose raw rows retention may have
    // taken (the fixture rows carry no path — the NULL group is the point).
    expect(resultOf(response, 'q').rows).toEqual([
      { bucket: OLD, path: null, pageviews: 1 },
      { bucket: RECENT, path: null, pageviews: 1 },
    ]);
  });

  it('answers raw shapes normally when the window stays above the floor', () => {
    const response = executeQueryRequest(pruned, {
      site: 1,
      range: { from: RECENT, to: RECENT },
      queries: [{ id: 'q', metrics: ['pageviews'], dim: 'title' }],
    });
    expect(resultOf(response, 'q').rows).toEqual([{ title: null, pageviews: 1 }]);
  });
});
