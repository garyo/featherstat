import {
  allSitesTemplate,
  type Filter,
  type FilterNode,
  MAX_QUERIES_PER_BATCH,
  overviewTemplate,
  type QueryResponse,
  SESSION_ONLY_METRICS,
} from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  collectBatch,
  hourlyWhenIntraday,
  wantsAnnotations,
  widgetData,
  withoutBlockedMetrics,
} from './batch.ts';

const siteOverview = overviewTemplate.build(1);
const allSites = (siteIds: readonly number[]) => allSitesTemplate.build('all', siteIds);

describe('collectBatch', () => {
  it('collects every widget query of the default site dashboard into one batch', () => {
    const { queries, slots } = collectBatch(siteOverview);
    expect(queries.map((query) => query.id)).toEqual([
      'kpis',
      'kpis~spark',
      'changes',
      'series',
      'pages',
      'refs',
      'countries',
      'devices',
      'devices~browsers',
      'events',
      'outlinks',
      'dwell',
      'heatmap',
    ]);
    expect(queries.length).toBeLessThanOrEqual(MAX_QUERIES_PER_BATCH);
    expect(slots.get('kpis')).toEqual({ main: 'kpis', spark: 'kpis~spark' });
    expect(slots.get('pages')).toEqual({ main: 'pages' });
    expect(slots.get('devices')).toEqual({ main: 'devices', browsers: 'devices~browsers' });
  });

  it('derives the KPI spark as a day-bucketed companion of the same metrics', () => {
    const { queries } = collectBatch(siteOverview);
    const spark = queries.find((query) => query.id === 'kpis~spark');
    const main = queries.find((query) => query.id === 'kpis');
    expect(spark).toBeDefined();
    if (spark === undefined || main === undefined || 'kind' in spark || 'kind' in main) {
      throw new Error('metric queries expected');
    }
    expect(spark.bucket).toBe('day');
    expect(spark.metrics).toEqual(main.metrics);
  });

  it('collects the all-sites view into one batch: cards plus one page query per site (R20)', () => {
    const siteIds = [1, 2, 3, 4, 5, 6];
    const { queries, slots } = collectBatch(allSites(siteIds));
    expect(queries.map((query) => query.id)).toEqual([
      'sites',
      // The cards' headline number: `visitors` is a distinct count, so the
      // bucketed result beside it cannot be summed into one (defect 13).
      'sites~totals',
      'sites~pages~1',
      'sites~pages~2',
      'sites~pages~3',
      'sites~pages~4',
      'sites~pages~5',
      'sites~pages~6',
    ]);
    expect(queries.length).toBeLessThanOrEqual(MAX_QUERIES_PER_BATCH);
    expect(slots.get('sites')).toEqual({
      main: 'sites',
      totals: 'sites~totals',
      'pages~1': 'sites~pages~1',
      'pages~2': 'sites~pages~2',
      'pages~3': 'sites~pages~3',
      'pages~4': 'sites~pages~4',
      'pages~5': 'sites~pages~5',
      'pages~6': 'sites~pages~6',
    });
  });

  it('shapes each per-site page query as a site-scoped daily path trend', () => {
    const { queries } = collectBatch(allSites([4]));
    const pages = queries.find((query) => query.id === 'sites~pages~4');
    expect(pages).toBeDefined();
    if (pages === undefined || 'kind' in pages) throw new Error('metric query expected');
    expect(pages.metrics).toEqual(['pageviews']);
    expect(pages.dim).toBe('path');
    expect(pages.bucket).toBe('day');
    expect(pages.filters).toEqual([{ dim: 'site', op: 'eq', value: '4' }]);
  });

  /**
   * A widget's own filters are part of its question, and the batch carries them
   * verbatim for a `kind` query exactly as for a metric one — two histograms
   * filtered differently must leave here as two different queries.
   */
  it('carries a kind widget’s own filters into the batch', () => {
    const filters = [{ dim: 'country' as const, op: 'eq' as const, value: 'SG' }];
    const { queries } = collectBatch({
      ...siteOverview,
      grid: [
        {
          id: 'scrollhist',
          viz: 'histogram',
          w: 6,
          h: 2,
          options: {},
          query: { id: 'scrollhist', kind: 'distribution', of: 'scroll', filters },
        },
      ],
    });
    expect(queries[0]?.filters).toEqual(filters);
    // The blocked-metric trim is a metric-query concern; it must not eat them.
    expect(withoutBlockedMetrics(queries, [])[0]?.filters).toEqual(filters);
  });

  it('ignores junk site ids in the widget options', () => {
    const dashboard = allSites([2]);
    const spec = dashboard.grid[0];
    if (spec === undefined) throw new Error('site-cards widget expected');
    const junk = { ...spec, options: { siteIds: [2, 0, -1, 1.5, 'x', null] } };
    const { queries } = collectBatch({ ...dashboard, grid: [junk] });
    expect(queries.map((query) => query.id)).toEqual(['sites', 'sites~totals', 'sites~pages~2']);
  });

  it('rejects a dashboard whose widgets collide on query ids', () => {
    const broken = {
      ...siteOverview,
      grid: [siteOverview.grid[0], siteOverview.grid[0]].flatMap((w) =>
        w === undefined ? [] : [w],
      ),
    };
    expect(() => collectBatch(broken)).toThrow(/duplicate query id/);
  });
});

describe('widgetData', () => {
  const { slots } = collectBatch(siteOverview);
  const kpis = siteOverview.grid[0];
  if (kpis === undefined) throw new Error('kpi widget expected');

  it('is loading before a response and error once a batch-level failure lands', () => {
    expect(widgetData(kpis, slots, undefined, undefined)).toEqual({
      phase: 'loading',
      message: undefined,
      results: {},
    });
    expect(widgetData(kpis, slots, undefined, 'boom')).toEqual({
      phase: 'error',
      message: 'boom',
      results: {},
    });
  });

  it('routes each declared slot to its own result by query id', () => {
    const response: QueryResponse = {
      results: {
        kpis: { rows: [{ visitors: 5 }] },
        'kpis~spark': { rows: [] },
      },
      meta: { generatedInMs: 1, dataVersion: 1, windows: [] },
    };
    const data = widgetData(kpis, slots, response, undefined);
    expect(data.phase).toBe('ready');
    expect(data.results.main).toEqual({ rows: [{ visitors: 5 }] });
    expect(data.results.spark).toEqual({ rows: [] });
  });

  it('yields empty results for a widget the batch never carried', () => {
    const stranger = { ...kpis, id: 'not-there' };
    const response: QueryResponse = {
      results: {},
      meta: { generatedInMs: 1, dataVersion: 1, windows: [] },
    };
    expect(widgetData(stranger, slots, response, undefined)).toEqual({
      phase: 'ready',
      results: {},
    });
  });
});

describe('hourlyWhenIntraday', () => {
  const { queries } = collectBatch(siteOverview);

  it('rewrites day buckets to hours for the ranges a day bucket cannot describe', () => {
    // `today` is one local day; `24h` is two partial ones — a day bucket draws a
    // point or a pair for either.
    for (const preset of ['today', '24h'] as const) {
      const hourly = hourlyWhenIntraday(queries, preset);
      const buckets = new Map(hourly.map((q) => [q.id, 'kind' in q ? undefined : q.bucket]));
      expect(buckets.get('series')).toBe('hour');
      expect(buckets.get('kpis')).toBeUndefined(); // totals stay unbucketed
      expect(buckets.get('pages')).toBeUndefined();
    }
  });

  // Left at day buckets under `24h` this drew two points whose spans were the
  // hours either side of local midnight, so flat traffic sloped down all
  // morning and up all evening. Sessions carry `local_hour` now, so the
  // companion goes hourly carrying every metric it declared — including the
  // session-level ones that used to have no hour to bucket by.
  it('takes the KPI spark companion hourly, session metrics and all', () => {
    const hourly = hourlyWhenIntraday(queries, '24h');
    const spark = hourly.find((q) => q.id === 'kpis~spark');
    if (spark === undefined || 'kind' in spark) throw new Error('metric query expected');
    expect(spark.bucket).toBe('hour');
    // Every metric the tile row declared, carried across untouched.
    const kpis = queries.find((q) => q.id === 'kpis');
    if (kpis === undefined || 'kind' in kpis) throw new Error('metric query expected');
    expect(spark.metrics).toEqual(kpis.metrics);
    expect(spark.metrics.some((m) => (SESSION_ONLY_METRICS as readonly string[]).includes(m))).toBe(
      true,
    );
  });

  it('leaves every other preset untouched, without mutating the input', () => {
    const same = hourlyWhenIntraday(queries, '30d');
    expect(same).toEqual(queries);
    expect(same).not.toBe(queries);
  });

  it('treats a single-day explicit range as intraday, and a longer one as days', () => {
    const oneDay = hourlyWhenIntraday(queries, { from: '2026-06-05', to: '2026-06-05' });
    const series = oneDay.find((q) => q.id === 'series');
    if (series === undefined || 'kind' in series) throw new Error('metric query expected');
    expect(series.bucket).toBe('hour');
    expect(hourlyWhenIntraday(queries, { from: '2026-06-01', to: '2026-06-05' })).toEqual(queries);
  });
});

describe('withoutBlockedMetrics', () => {
  const { queries } = collectBatch(siteOverview);
  const pathFilter: Filter[] = [{ dim: 'path', op: 'eq', value: '/x' }];

  it('trims session-only metrics when a filter uses an event-level dim', () => {
    const trimmed = withoutBlockedMetrics(queries, pathFilter);
    const kpis = trimmed.find((q) => q.id === 'kpis');
    if (kpis === undefined || 'kind' in kpis) throw new Error('metric query expected');
    // The KPI row survives the click-to-filter instead of erroring whole.
    expect(kpis.metrics).toEqual(['visitors', 'pageviews', 'visits']);
    const spark = trimmed.find((q) => q.id === 'kpis~spark');
    if (spark === undefined || 'kind' in spark) throw new Error('metric query expected');
    expect(spark.metrics).toEqual(['visitors', 'pageviews', 'visits']);
  });

  it('trims event-only metrics when a filter uses a session-only dim (entry/exit page)', () => {
    const entryFilter: Filter[] = [{ dim: 'entry_path', op: 'eq', value: '/x' }];
    const trimmed = withoutBlockedMetrics(queries, entryFilter);
    const kpis = trimmed.find((q) => q.id === 'kpis');
    if (kpis === undefined || 'kind' in kpis) throw new Error('metric query expected');
    // The session-shaped metrics survive; the events-table ones are the blocked side now.
    expect(kpis.metrics).toEqual([
      'visits',
      'engaged_ms',
      'engaged_sessions',
      'avg_engagement',
      'bounce_rate',
    ]);
  });

  it('reaches the leaves of an expression, not just a bare chip', () => {
    // A view chip may be a whole tree now. The event-level dim buried in the
    // `any` still blocks the session metrics — reading `.dim` off the node
    // (which a group has not got) silently blocked nothing at all.
    const grouped: FilterNode[] = [
      {
        any: [
          { dim: 'path', op: 'eq', value: '/x' },
          { dim: 'path', op: 'eq', value: '/y' },
        ],
      },
    ];
    const trimmed = withoutBlockedMetrics(queries, grouped);
    const kpis = trimmed.find((q) => q.id === 'kpis');
    if (kpis === undefined || 'kind' in kpis) throw new Error('metric query expected');
    expect(kpis.metrics).toEqual(['visitors', 'pageviews', 'visits']);
  });

  it('lets a session-scoped leaf inside a tree block nothing, as the compiler reads it', () => {
    const scoped: FilterNode[] = [
      { not: { dim: 'path', op: 'eq', value: '/x', scope: 'session' } },
    ];
    const trimmed = withoutBlockedMetrics(queries, scoped);
    const kpis = trimmed.find((q) => q.id === 'kpis');
    if (kpis === undefined || 'kind' in kpis) throw new Error('metric query expected');
    const unfiltered = queries.find((q) => q.id === 'kpis');
    if (unfiltered === undefined || 'kind' in unfiltered) throw new Error('metric query expected');
    expect(kpis.metrics).toEqual(unfiltered.metrics);
  });

  it('treats a prop:<key> filter as event-level, exactly as the compiler does', () => {
    const propFilter: Filter[] = [{ dim: 'prop:plan', op: 'eq', value: 'pro' }];
    const trimmed = withoutBlockedMetrics(queries, propFilter);
    const kpis = trimmed.find((q) => q.id === 'kpis');
    if (kpis === undefined || 'kind' in kpis) throw new Error('metric query expected');
    expect(kpis.metrics).toEqual(['visitors', 'pageviews', 'visits']);
  });

  it("a scope:'session' filter blocks nothing, exactly as the compiler reads it", () => {
    const scoped: Filter[] = [{ dim: 'path', op: 'eq', value: '/x', scope: 'session' }];
    expect(withoutBlockedMetrics(queries, scoped)).toEqual(queries);
  });

  it('is inert for session-level filters and mutates nothing', () => {
    const countryFilter: Filter[] = [{ dim: 'country', op: 'eq', value: 'US' }];
    expect(withoutBlockedMetrics(queries, countryFilter)).toEqual(queries);
    withoutBlockedMetrics(queries, pathFilter);
    const kpis = queries.find((q) => q.id === 'kpis');
    if (kpis === undefined || 'kind' in kpis) throw new Error('metric query expected');
    expect(kpis.metrics).toContain('engaged_ms'); // input untouched
  });

  it('trims a widget-filtered query by ITS filters while the rest of the view keeps theirs', () => {
    // The pre-existing sharp edge (v2 plan risk 7): blockers are per query, so
    // a widget scoped to one page loses its session metrics and the unscoped
    // widget beside it keeps every one.
    const scoped = [
      {
        id: 'page-kpis',
        metrics: ['pageviews', 'bounce_rate'] as ('pageviews' | 'bounce_rate')[],
        filters: [{ dim: 'path' as const, op: 'eq' as const, value: '/x' }],
      },
      { id: 'kpis', metrics: ['pageviews', 'bounce_rate'] as ('pageviews' | 'bounce_rate')[] },
    ];
    const trimmed = withoutBlockedMetrics(scoped, []);
    const filtered = trimmed[0];
    const plain = trimmed[1];
    if (filtered === undefined || 'kind' in filtered || plain === undefined || 'kind' in plain) {
      throw new Error('metric queries expected');
    }
    expect(filtered.metrics).toEqual(['pageviews']);
    expect(plain.metrics).toEqual(['pageviews', 'bounce_rate']);
  });

  it("a widget's scope:'session' filter blocks nothing, like the view's", () => {
    const scoped = [
      {
        id: 'q',
        metrics: ['pageviews', 'bounce_rate'] as ('pageviews' | 'bounce_rate')[],
        filters: [
          { dim: 'path' as const, op: 'eq' as const, value: '/x', scope: 'session' as const },
        ],
      },
    ];
    expect(withoutBlockedMetrics(scoped, [])).toEqual(scoped);
  });

  it('trims by a PIVOTED grouping dimension, so a pivot cannot blank a mixed list', () => {
    // Pivoting a referrers list (session-capable dim) onto `path` groups by an
    // event-only dimension; its session metric goes, its counts stay.
    const pivoted = [
      {
        id: 'refs',
        metrics: ['visitors', 'bounce_rate'] as ('visitors' | 'bounce_rate')[],
        dim: 'path' as const,
        limit: 8,
      },
    ];
    const trimmed = withoutBlockedMetrics(pivoted, []);
    const refs = trimmed[0];
    if (refs === undefined || 'kind' in refs) throw new Error('metric query expected');
    expect(refs.metrics).toEqual(['visitors']);
  });

  it('leaves a query alone when trimming would empty it — the per-query error is honest', () => {
    const trimmed = withoutBlockedMetrics(
      [{ id: 'only-session', metrics: ['engaged_ms', 'bounce_rate'] }],
      pathFilter,
    );
    const only = trimmed[0];
    if (only === undefined || 'kind' in only) throw new Error('metric query expected');
    expect(only.metrics).toEqual(['engaged_ms', 'bounce_rate']);
  });
});

describe('wantsAnnotations', () => {
  it('opts in exactly when the dashboard renders a timeseries', () => {
    // The markers draw on time charts; a dashboard without one must not widen
    // its ETag to the annotations version (docs/04 § 3 — opt-in delivery).
    expect(wantsAnnotations(siteOverview)).toBe(true);
    expect(wantsAnnotations(allSites([1]))).toBe(false);
    expect(
      wantsAnnotations({
        ...siteOverview,
        grid: siteOverview.grid.filter((spec) => spec.viz !== 'timeseries'),
      }),
    ).toBe(false);
  });
});
