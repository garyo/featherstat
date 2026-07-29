import {
  collectBatch,
  type Dashboard,
  DashboardSchema,
  upgradeDashboard,
} from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { tileLabel, tileModels, tileNames } from './kpi.ts';
import type { SeriesPoint } from './series.ts';

const TOTALS = {
  visitors: 1200,
  pageviews: 3000,
  visits: 100,
  engaged_sessions: 100,
  engaged_ms: 10_600_000,
  bounce_rate: 0.31,
};
const COMPARE = {
  visitors: 1000,
  pageviews: 3300,
  visits: 100,
  engaged_sessions: 100,
  engaged_ms: 9_900_000,
  bounce_rate: 0.33,
};

function day(bucket: string, values: SeriesPoint['values']): SeriesPoint {
  return { bucket, values };
}

describe('tileNames', () => {
  it('defaults to the docs/05 quartet and drops unknown names', () => {
    expect(tileNames({})).toEqual(['visitors', 'pageviews', 'avg_engagement', 'bounce_rate']);
    expect(tileNames({ tiles: ['visitors', 'nope', 42] })).toEqual(['visitors']);
    expect(tileLabel('avg_engagement')).toBe('Avg engagement');
  });
});

describe('tileModels', () => {
  const models = tileModels(tileNames({}), TOTALS, COMPARE, []);
  const byName = new Map(models.map((model) => [model.name, model]));

  it('formats counts with a percent delta, arrow leading', () => {
    const visitors = byName.get('visitors');
    expect(visitors?.value).toBe('1,200');
    expect(visitors?.delta).toEqual({ text: '▴ +20.0%', tone: 'up' });
    const pageviews = byName.get('pageviews');
    expect(pageviews?.delta).toEqual({ text: '▾ −9.1%', tone: 'down' });
  });

  it('derives avg engagement from engaged_ms / MEASURED visits, with a duration delta', () => {
    const tile = byName.get('avg_engagement');
    expect(tile?.value).toBe('1m 46s'); // 10 600 000 ms / 100 visits
    expect(tile?.delta).toEqual({ text: '▴ +7s', tone: 'up' });
  });

  it('colors bounce-rate down as good (direction × goodness)', () => {
    const tile = byName.get('bounce_rate');
    expect(tile?.value).toBe('31%');
    expect(tile?.delta).toEqual({ text: '▾ −2.0 pt', tone: 'up' });
  });

  it('mutes the delta when there is nothing to compare against', () => {
    const [visitors] = tileModels(['visitors'], TOTALS, undefined, []);
    expect(visitors?.delta).toEqual({ text: '—', tone: 'muted' });
    const [fromZero] = tileModels(['visitors'], TOTALS, { visitors: 0 }, []);
    expect(fromZero?.delta.tone).toBe('muted');
  });

  it('shows an em-dash value when the stat is unanswerable', () => {
    const [tile] = tileModels(['avg_engagement'], { engaged_ms: 0, visits: 0 }, undefined, []);
    expect(tile?.value).toBe('—');
  });

  it('renders again for a stored layout that predates engaged_sessions', () => {
    // The whole defect, end to end: a dashboard saved before f47d1e5 asks for
    // engaged_ms without the denominator, so its tile can only read '—'.
    const stored = DashboardSchema.parse({
      name: 'Overview',
      site: 1,
      grid: [
        {
          id: 'kpis',
          viz: 'kpi-row',
          w: 12,
          h: 1,
          options: { tiles: ['avg_engagement'] },
          query: { id: 'kpis', metrics: ['visits', 'engaged_ms'] },
        },
      ],
    });
    // Executing what was stored answers only the metrics it named.
    const answer = (metrics: readonly string[]) =>
      Object.fromEntries(
        metrics.map((metric) => [metric, metric === 'engaged_ms' ? 3_060_000 : 100]),
      );
    const queryOf = (dashboard: Dashboard) => {
      const query = collectBatch(dashboard).queries[0];
      if (query === undefined || 'kind' in query) throw new Error('metric query expected');
      return query;
    };

    const [before] = tileModels(['avg_engagement'], answer(queryOf(stored).metrics), undefined, []);
    expect(before?.value).toBe('—');

    const upgraded = upgradeDashboard(stored);
    expect(queryOf(upgraded).metrics).toContain('engaged_sessions');
    const [after] = tileModels(
      ['avg_engagement'],
      answer(queryOf(upgraded).metrics),
      undefined,
      [],
    );
    expect(after?.value).toBe('31s'); // 3 060 000 ms over 100 measured visits
  });

  it('reduces the companion series into at most 12 spark points', () => {
    const series = Array.from({ length: 24 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, '0')}`, {
        visitors: 1,
        visits: 2,
        // One of the two visits was measurable — the spark averages over that.
        engaged_sessions: 1,
        engaged_ms: 4000,
      }),
    );
    const [visitors] = tileModels(['visitors'], TOTALS, undefined, series);
    expect(visitors?.spark).toEqual(Array.from({ length: 12 }, () => 2));
    const [engagement] = tileModels(['avg_engagement'], TOTALS, undefined, series);
    expect(engagement?.spark).toEqual(Array.from({ length: 12 }, () => 4000));
  });

  it('weights the bounce spark by visits, not by day', () => {
    const series = [
      day('2026-07-01', { bounce_rate: 1, visits: 1 }),
      day('2026-07-02', { bounce_rate: 0, visits: 9 }),
    ];
    const [tile] = tileModels(['bounce_rate'], TOTALS, undefined, series);
    expect(tile?.spark).toEqual([100, 0]); // two slices; a mean-of-days would say 50
  });
});
