import {
  collectBatch,
  type Dashboard,
  DashboardSchema,
  type Measure,
  type Measures,
  type ResultRow,
  upgradeDashboard,
} from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { formatMeasure } from './format.ts';
import { tileLabel, tileModels, tileNames } from './kpi.ts';
import type { SeriesPoint } from './series.ts';

/**
 * The measures header the server sends for a KPI query (docs/04 § 3) — the
 * declarations `apps/server/src/query/compiler.test.ts` pins on the other side.
 * Every unit and every reduction below comes from here, which is the point: the
 * tile carries no arithmetic of its own to disagree with.
 */
const MEASURES: Measures = {
  visitors: { unit: 'count', population: 'actions', aggregate: 'distinct' },
  pageviews: { unit: 'count', population: 'pageviews', aggregate: 'sum' },
  visits: { unit: 'count', population: 'sessions', aggregate: 'sum' },
  engaged_ms: { unit: 'ms', population: 'sessions', aggregate: 'sum' },
  engaged_sessions: { unit: 'count', population: 'measured_sessions', aggregate: 'sum' },
  avg_engagement: {
    unit: 'ms',
    population: 'measured_sessions',
    aggregate: 'ratio',
    of: { numerator: 'engaged_ms', denominator: 'engaged_sessions' },
  },
  bounce_rate: {
    unit: 'rate',
    population: 'sessions',
    aggregate: 'ratio',
    of: { denominator: 'visits' },
  },
};

const TOTALS = {
  visitors: 1200,
  pageviews: 3000,
  visits: 100,
  engaged_sessions: 100,
  engaged_ms: 10_600_000,
  avg_engagement: 106_000,
  bounce_rate: 0.31,
};
const COMPARE = {
  visitors: 1000,
  pageviews: 3300,
  visits: 100,
  engaged_sessions: 100,
  engaged_ms: 9_900_000,
  avg_engagement: 99_000,
  bounce_rate: 0.33,
};

function day(bucket: string, values: SeriesPoint['values']): SeriesPoint {
  return { bucket, values };
}

/**
 * The common call: totals + compare + a companion series, all against MEASURES.
 * The companion answers whatever the main result does unless a test says
 * otherwise — which is what an intraday range does to the session metrics.
 */
function models(
  names: readonly string[],
  totals: ResultRow | undefined = TOTALS,
  compare?: ResultRow,
  series: readonly SeriesPoint[] = [],
  measures: Measures | undefined = MEASURES,
  seriesMeasures: Measures | undefined = measures,
) {
  return tileModels(names, { totals, compare, series, measures, seriesMeasures });
}

describe('tileNames', () => {
  it('defaults to the docs/05 quartet and drops unknown names', () => {
    expect(tileNames({})).toEqual(['visitors', 'pageviews', 'avg_engagement', 'bounce_rate']);
    expect(tileNames({ tiles: ['visitors', 'nope', 42] })).toEqual(['visitors']);
    expect(tileLabel('avg_engagement')).toBe('Avg engagement');
  });
});

describe('tileModels', () => {
  const byName = new Map(
    models(tileNames({}), TOTALS, COMPARE).map((model) => [model.name, model]),
  );

  it('formats counts with a percent delta, arrow leading', () => {
    const visitors = byName.get('visitors');
    expect(visitors?.value).toBe('1,200');
    expect(visitors?.delta).toEqual({ text: '▴ +20.0%', tone: 'up' });
    const pageviews = byName.get('pageviews');
    expect(pageviews?.delta).toEqual({ text: '▾ −9.1%', tone: 'down' });
  });

  it('reads avg engagement as a metric — the client no longer divides', () => {
    // 10 600 000 ms over 100 measured visits, but the tile never computes that:
    // the server did, over the population that makes it honest, and the tile
    // reads the column. Two copies of this division used to live here.
    const tile = byName.get('avg_engagement');
    expect(tile?.value).toBe('1m 46s');
    expect(tile?.delta).toEqual({ text: '▴ +7s', tone: 'up' });
  });

  it('marks a distinct count as approximate over a range, from the aggregate alone', () => {
    // docs/03 § Visitor identity: the id salt rotates at 00:00 UTC, so a
    // visitor count is exact within a day and an approximation over anything
    // longer. The tile learns that from `aggregate: 'distinct'`, not from the
    // metric's name — which is what makes the claim in docs/03 true in the UI.
    expect(byName.get('visitors')?.approximate).toBe(true);
    expect(byName.get('pageviews')?.approximate).toBe(false);
    expect(byName.get('avg_engagement')?.approximate).toBe(false);
  });

  it('colors bounce-rate down as good (direction × goodness)', () => {
    const tile = byName.get('bounce_rate');
    expect(tile?.value).toBe('31%');
    expect(tile?.delta).toEqual({ text: '▾ −2.0 pt', tone: 'up' });
  });

  it('mutes the delta when there is nothing to compare against', () => {
    const [visitors] = models(['visitors']);
    expect(visitors?.delta).toEqual({ text: '—', tone: 'muted' });
    const [fromZero] = models(['visitors'], TOTALS, { visitors: 0 });
    expect(fromZero?.delta.tone).toBe('muted');
  });

  it('shows an em-dash when the result did not answer the metric', () => {
    // An event-level filter trims the session metrics (docs/04 § 3), so neither
    // the column nor its measure comes back. '—' is the reading; 0 s would claim
    // the traffic was measured and found empty.
    const trimmed = models(['avg_engagement'], { visitors: 5 }, undefined, [], {
      visitors: { unit: 'count', population: 'actions', aggregate: 'distinct' },
    })[0];
    expect(trimmed?.value).toBe('—');
    expect(trimmed?.spark).toEqual([]);

    // And with the measure but no value — a null ratio on an empty denominator.
    const [unmeasured] = models(['avg_engagement'], { avg_engagement: null });
    expect(unmeasured?.value).toBe('—');
  });

  it('renders again for a stored layout that predates avg_engagement', () => {
    // The v2 → v3 defect end to end: a dashboard saved before this phase asks
    // for engaged_ms and engaged_sessions, so the tile that now READS
    // avg_engagement can only show '—' until the layout is carried forward.
    const stored = DashboardSchema.parse({
      version: 2,
      name: 'Overview',
      site: 1,
      grid: [
        {
          id: 'kpis',
          viz: 'kpi-row',
          w: 12,
          h: 1,
          options: { tiles: ['avg_engagement'] },
          query: { id: 'kpis', metrics: ['visits', 'engaged_ms', 'engaged_sessions'] },
        },
      ],
    });
    /** Executing what was stored answers only the metrics it named. */
    const ANSWERS: Record<string, number> = { engaged_ms: 3_060_000, avg_engagement: 30_600 };
    const answer = (metrics: readonly string[]) => ({
      totals: Object.fromEntries(metrics.map((metric) => [metric, ANSWERS[metric] ?? 100])),
      measures: Object.fromEntries(
        metrics.flatMap((metric) => {
          const measure = MEASURES[metric];
          return measure === undefined ? [] : [[metric, measure]];
        }),
      ) as Measures,
    });
    const queryOf = (dashboard: Dashboard) => {
      const query = collectBatch(dashboard).queries[0];
      if (query === undefined || 'kind' in query) throw new Error('metric query expected');
      return query;
    };

    const stale = answer(queryOf(stored).metrics);
    const [before] = models(['avg_engagement'], stale.totals, undefined, [], stale.measures);
    expect(before?.value).toBe('—');

    const upgraded = upgradeDashboard(stored);
    expect(queryOf(upgraded).metrics).toContain('avg_engagement');
    const fresh = answer(queryOf(upgraded).metrics);
    const [after] = models(['avg_engagement'], fresh.totals, undefined, [], fresh.measures);
    expect(after?.value).toBe('31s'); // 3 060 000 ms over 100 measured visits, divided server-side
  });

  it('reduces the companion series into at most 12 spark points, per bucket', () => {
    const series = Array.from({ length: 24 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, '0')}`, {
        visitors: 1,
        visits: 2,
        // One of the two visits was measurable — the ratio divides by that.
        engaged_sessions: 1,
        engaged_ms: 4000,
        avg_engagement: 4000,
      }),
    );
    // A spark point is the value for ONE bucket of its slice, not the slice's
    // total: 24 days over 12 slices is 2 days each, and each day had 1 visitor.
    const [visitors] = models(['visitors'], TOTALS, undefined, series);
    expect(visitors?.spark).toEqual(Array.from({ length: 12 }, () => 1));
    const [engagement] = models(['avg_engagement'], TOTALS, undefined, series);
    expect(engagement?.spark).toEqual(Array.from({ length: 12 }, () => 4000));
  });

  it('weights the bounce spark by visits, not by day', () => {
    const series = [
      day('2026-07-01', { bounce_rate: 1, visits: 1 }),
      day('2026-07-02', { bounce_rate: 0, visits: 9 }),
    ];
    const [tile] = models(['bounce_rate'], TOTALS, undefined, series);
    expect(tile?.spark).toEqual([1, 0]); // two slices; a mean-of-days would say 0.5
  });

  /**
   * The scale bug, as a property rather than a case.
   *
   * With ONE bucket that carries exactly the totals row's values, every
   * reduction — a sum of one, a mean of one, a ratio of one — is that row's own
   * value. So writing the spark point with its measure's unit MUST produce the
   * tile's own text. The bounce tile used to write 0.31 as '31%' while its
   * sparkline computed 31 (already ×100) and would have written '3100%'; any
   * future tile that re-scales on one side and not the other fails here too.
   */
  it('writes a tile and its own sparkline on the same scale', () => {
    const names = ['visitors', 'pageviews', 'visits', 'avg_engagement', 'bounce_rate'];
    const one = [day('2026-07-01', { ...TOTALS })];
    for (const tile of models(names, TOTALS, undefined, one)) {
      const unit = MEASURES[tile.name]?.unit;
      if (unit === undefined) throw new Error(`no measure for ${tile.name}`);
      expect(tile.spark, `${tile.name} spark`).toHaveLength(1);
      expect(formatMeasure(unit, tile.spark[0] ?? Number.NaN), `${tile.name} scale`).toBe(
        tile.value,
      );
    }
  });

  /**
   * Hourly buckets on a quiet site: some hours had visits and some had none, and
   * a bounce rate over an hour with no visits is unknown rather than zero. The
   * measured hours still draw — dropping the line for them would leave the
   * metric with no intraday shape at all on exactly the sites that need one.
   */
  it('leaves a gap for a period it could not measure, and draws the rest', () => {
    const series = [
      day('2026-07-01 09:00', { bounce_rate: 1, visits: 2 }),
      day('2026-07-01 10:00', { bounce_rate: 0, visits: 0 }), // nobody came
      day('2026-07-01 11:00', { bounce_rate: 0, visits: 4 }),
    ];
    const [tile] = models(['bounce_rate'], TOTALS, undefined, series);
    expect(tile?.spark).toEqual([1, undefined, 0]);
    // The gap neither raises the peak nor stands for a zero.
    expect(tile?.scale).toEqual({ peak: '100%', floor: '0%' });
  });

  it('drops the whole sparkline when a slice cannot be reduced', () => {
    // bounce_rate re-weights on `visits`; a companion that did not ask for it
    // has nothing to weight by, so there is no honest line to draw.
    const series = [day('2026-07-01', { bounce_rate: 1 }), day('2026-07-02', { bounce_rate: 0 })];
    const [tile] = models(['bounce_rate'], TOTALS, undefined, series);
    expect(tile?.value).toBe('31%');
    expect(tile?.spark).toEqual([]);
  });

  /**
   * The line is zero-anchored, so its bottom edge says zero and only the peak
   * beside it separates a bump of two from a bump of two thousand. Both are
   * written in the measure's own unit, like the tile's value.
   */
  it('states the sparkline range in the metric’s unit', () => {
    const series = [
      day('2026-07-01', { visitors: 2, bounce_rate: 0.5, visits: 2 }),
      day('2026-07-02', { visitors: 9, bounce_rate: 0.1, visits: 2 }),
    ];
    const [visitors, bounce] = models(['visitors', 'bounce_rate'], TOTALS, undefined, series);
    expect(visitors?.scale).toEqual({ peak: '9', floor: '0' });
    expect(bounce?.scale).toEqual({ peak: '50%', floor: '0%' });
  });

  it('labels a flat line from zero, an all-zero line as one number, and none as none', () => {
    const flat = [day('2026-07-01', { visitors: 4 }), day('2026-07-02', { visitors: 4 })];
    expect(models(['visitors'], TOTALS, undefined, flat)[0]?.scale).toEqual({
      peak: '4',
      floor: '0',
    });
    const zero = [day('2026-07-01', { visitors: 0 }), day('2026-07-02', { visitors: 0 })];
    expect(models(['visitors'], TOTALS, undefined, zero)[0]?.scale).toEqual({
      peak: '0',
      floor: undefined,
    });
    // No companion, so no line — and nothing to put an axis on.
    expect(models(['visitors'])[0]?.scale).toBeUndefined();
  });

  /**
   * What an intraday range does: the companion goes hourly, which only the
   * events side can answer, so it comes back WITHOUT the session metrics. The
   * number still reads off the main result — only the line is missing. Without
   * this the tile drew a flat line at zero, because `seriesOf` zero-fills a
   * column its rows never carried, which reads as "no bounces all day".
   */
  it('sparks only what the companion answered, never a zero-filled column', () => {
    const hourly: Measures = { visitors: MEASURES.visitors as Measure };
    const series = [day('2026-07-01 00:00', { visitors: 3 }), day('2026-07-01 01:00', {})];
    const [visitors, bounce] = models(
      ['visitors', 'bounce_rate'],
      TOTALS,
      undefined,
      series,
      MEASURES,
      hourly,
    );
    expect(visitors?.spark).toEqual([3, 0]);
    expect(bounce?.value).toBe('31%'); // the number survives
    expect(bounce?.spark).toEqual([]); // the fabricated flat line does not
  });
});
