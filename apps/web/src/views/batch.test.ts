import { MAX_QUERIES_PER_BATCH } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { allSites } from '../dashboards/all-sites.ts';
import { siteOverview } from '../dashboards/site-overview.ts';
import { collectBatch, hourlyWhenToday } from './batch.ts';

describe('collectBatch', () => {
  it('collects every widget query of the default site dashboard into one batch', () => {
    const { queries, slots } = collectBatch(siteOverview);
    expect(queries.map((query) => query.id)).toEqual([
      'kpis',
      'kpis~spark',
      'series',
      'pages',
      'refs',
    ]);
    expect(queries.length).toBeLessThanOrEqual(MAX_QUERIES_PER_BATCH);
    expect(slots.get('kpis')).toEqual({ main: 'kpis', spark: 'kpis~spark' });
    expect(slots.get('pages')).toEqual({ main: 'pages' });
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

  it('collects the all-sites view down to a single query', () => {
    const { queries, slots } = collectBatch(allSites);
    expect(queries).toHaveLength(1);
    expect(slots.get('sites')).toEqual({ main: 'sites' });
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
