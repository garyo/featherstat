import { type Filter, MAX_QUERIES_PER_BATCH } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { allSites } from '../dashboards/all-sites.ts';
import { siteOverview } from '../dashboards/site-overview.ts';
import { collectBatch, hourlyWhenToday, withoutBlockedMetrics } from './batch.ts';

describe('collectBatch', () => {
  it('collects every widget query of the default site dashboard into one batch', () => {
    const { queries, slots } = collectBatch(siteOverview);
    expect(queries.map((query) => query.id)).toEqual([
      'kpis',
      'kpis~spark',
      'series',
      'pages',
      'refs',
      'countries',
      'devices',
      'devices~browsers',
      'events',
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

  it('ignores junk site ids in the widget options', () => {
    const dashboard = allSites([2]);
    const spec = dashboard.grid[0];
    if (spec === undefined) throw new Error('site-cards widget expected');
    const junk = { ...spec, options: { siteIds: [2, 0, -1, 1.5, 'x', null] } };
    const { queries } = collectBatch({ ...dashboard, grid: [junk] });
    expect(queries.map((query) => query.id)).toEqual(['sites', 'sites~pages~2']);
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

describe('hourlyWhenToday', () => {
  const { queries } = collectBatch(siteOverview);

  it('rewrites day buckets to hours only for the today preset', () => {
    const hourly = hourlyWhenToday(queries, 'today');
    const buckets = new Map(hourly.map((q) => [q.id, 'kind' in q ? undefined : q.bucket]));
    expect(buckets.get('series')).toBe('hour');
    expect(buckets.get('kpis')).toBeUndefined(); // totals stay unbucketed
    expect(buckets.get('pages')).toBeUndefined();
  });

  it('leaves the KPI spark companion day-bucketed — its session metrics cannot take hours', () => {
    const hourly = hourlyWhenToday(queries, 'today');
    const spark = hourly.find((q) => q.id === 'kpis~spark');
    expect(spark).toBeDefined();
    if (spark === undefined || 'kind' in spark) throw new Error('metric query expected');
    expect(spark.bucket).toBe('day');
  });

  it('leaves every other preset untouched, without mutating the input', () => {
    const same = hourlyWhenToday(queries, '30d');
    expect(same).toEqual(queries);
    expect(same).not.toBe(queries);
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

  it('is inert for session-level filters and mutates nothing', () => {
    const countryFilter: Filter[] = [{ dim: 'country', op: 'eq', value: 'US' }];
    expect(withoutBlockedMetrics(queries, countryFilter)).toEqual(queries);
    withoutBlockedMetrics(queries, pathFilter);
    const kpis = queries.find((q) => q.id === 'kpis');
    if (kpis === undefined || 'kind' in kpis) throw new Error('metric query expected');
    expect(kpis.metrics).toContain('engaged_ms'); // input untouched
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
