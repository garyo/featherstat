import {
  type Dashboard,
  DashboardSchema,
  MAX_METRICS_PER_QUERY,
  type Measure,
  type Metric,
  MetricSchema,
  type ResultRow,
  upgradeDashboard,
} from '@featherstat/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { resultAxes, sharedKeys } from '../../apps/web/src/widgets/axis.ts';
import { barRows } from '../../apps/web/src/widgets/bar-rows.ts';
import { dwellBars, dwellRows } from '../../apps/web/src/widgets/dwell.ts';
import { formatMeasure, METRIC_LABELS } from '../../apps/web/src/widgets/format.ts';
import { tileModels, tileNames } from '../../apps/web/src/widgets/kpi.ts';
import { seriesOf } from '../../apps/web/src/widgets/series.ts';
import { siteStats } from '../../apps/web/src/widgets/site-stats.ts';
import {
  allSitesAnswer,
  answer,
  CONTRACT_SITE,
  closeContractDb,
  corpus,
  metricQueryOf,
  NOW,
  siteAnswer,
  sliceOf,
  widgetOf,
} from './corpus.ts';

/**
 * The seam between the two packages: what the server answers, read by the code
 * that reads it.
 *
 * Both halves are unit-tested and both pass — the compiler against its own
 * vocabulary, the widgets against literals a human typed. That leaves exactly
 * one thing untested, and it is where the defects were: whether the literals
 * describe what the server actually sends. `kpi.test.ts` asserts a tile shows
 * `1m 46s` for a hand-written `avg_engagement: 106_000`; nothing asked the
 * server for an avg engagement and checked that the number the tile then wrote
 * was over the right denominator.
 *
 * These live at the repo root rather than beside either half. See CLAUDE.md
 * § Conventions — it is the one exemption to "tests live beside the code they
 * test", because there is no "beside" for a seam.
 */

afterAll(closeContractDb);

const site = siteAnswer();

describe('every question the shipped dashboard asks gets an answer', () => {
  it('answers every slot every widget declared, with no per-query errors', () => {
    // A dashboard is a client-authored query plan; the batch it collects has to
    // be one the compiler will actually take. A vocabulary change that made one
    // widget's combination unanswerable would blank that card in production and
    // nothing else would notice.
    const failures = Object.entries(site.response.results).flatMap(([id, entry]) =>
      'error' in entry ? [`${id}: ${entry.error.message}`] : [],
    );
    expect(failures).toEqual([]);
    expect(Object.keys(site.response.results).length).toBe(site.request.queries.length);
  });

  it('declares a measure for every metric column it returns', () => {
    // The tile reads its unit and its aggregate off the answer (P2). A metric
    // answered without its declaration renders '—' forever, silently — which is
    // exactly how a stored layout one vocabulary behind used to fail.
    for (const query of site.request.queries) {
      if ('kind' in query) continue;
      const entry = site.response.results[query.id];
      if (entry === undefined || 'error' in entry) throw new Error(`no result for ${query.id}`);
      expect(Object.keys(entry.measures ?? {}).sort(), query.id).toEqual([...query.metrics].sort());
    }
  });

  it('answers each site of a batch in its own timezone', () => {
    // `site: 'all'` fans out across zones, so there is no single window that
    // describes the response — which is why `meta.windows` is an array and why
    // no client resolves a preset (P1).
    const windows = allSitesAnswer().response.meta.windows;
    expect(windows.map((window) => window.siteId).sort((a, b) => a - b)).toEqual(
      corpus.sites.map((s) => s.id),
    );
    expect(new Set(windows.map((window) => window.timezone)).size).toBeGreaterThan(1);
  });
});

describe('a KPI tile writes the server’s own number', () => {
  const spec = widgetOf(site.dashboard, 'kpis');
  const main = sliceOf(site, 'kpis');
  const spark = sliceOf(site, 'kpis', 'spark');
  const totals = main.rows[0] as ResultRow;
  const series = seriesOf(
    spark.rows,
    metricQueryOf(spec).metrics,
    sharedKeys(resultAxes(spark, site.response.meta.windows, NOW)),
  );
  const tiles = new Map(
    tileModels(tileNames(spec.options), {
      totals,
      compare: main.compare?.[0],
      series,
      measures: main.measures,
    }).map((tile) => [tile.name, tile]),
  );

  const numberOf = (metric: string): number => {
    const value = totals[metric];
    if (typeof value !== 'number') throw new Error(`${metric} answered ${String(value)}`);
    return value;
  };

  it('divides engaged time by the visits that could be measured, not by all of them', () => {
    // THE denominator test. `avg_engagement` is a server ratio over
    // `measured_sessions` — visits with time on the clock — because a single-hit
    // visit is unmeasurable, not 0 s. Dividing by `visits` instead gives a
    // smaller, plausible, wrong number that no literal fixture could expose.
    const engagedMs = numberOf('engaged_ms');
    const measured = numberOf('engaged_sessions');
    const visits = numberOf('visits');
    expect(measured).toBeGreaterThan(0);
    expect(measured).toBeLessThan(visits); // the two denominators really differ here
    expect(numberOf('avg_engagement')).toBeCloseTo(engagedMs / measured, 6);
    expect(tiles.get('avg_engagement')?.value).toBe(formatMeasure('ms', engagedMs / measured));
  });

  it('keeps a rate a fraction on the wire and scales it exactly once on screen', () => {
    const rate = numberOf('bounce_rate');
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(1); // 0–1 server-side, never pre-scaled
    expect(tiles.get('bounce_rate')?.value).toBe(`${Math.round(rate * 100)}%`);
  });

  it('reduces the real bucketed companion onto the tile’s own scale', () => {
    // The sparkline reduces the SAME answer the tile reads, so both are written
    // with the measure's unit. A rate that arrived pre-scaled on one side (0–100
    // against 0–1) shows up here as a spark whose points cannot be written the
    // way the tile's number was — that bug shipped, and only on screen.
    expect(tiles.size).toBeGreaterThan(0);
    for (const tile of tiles.values()) {
      const measure = main.measures?.[tile.name] as Measure | undefined;
      if (measure === undefined) throw new Error(`no measure for ${tile.name}`);
      expect(tile.spark.length, `${tile.name} spark`).toBeGreaterThan(1);
      for (const point of tile.spark) {
        expect(Number.isFinite(point), `${tile.name} spark point`).toBe(true);
        expect(formatMeasure(measure.unit, point), `${tile.name} spark scale`).not.toMatch(
          /NaN|\d{4,}%/,
        );
      }
    }
  });

  it('marks exactly the distinct counts approximate', () => {
    // docs/03 § Visitor identity, held against the server's own declaration
    // rather than against a metric name the client remembers.
    for (const tile of tiles.values()) {
      const measure = main.measures?.[tile.name] as Measure | undefined;
      expect(tile.approximate, tile.name).toBe(measure?.aggregate === 'distinct');
    }
    expect(tiles.get('visitors')?.approximate).toBe(true);
  });

  it('shows a signed delta against the server’s own compare row', () => {
    const compare = main.compare?.[0];
    expect(compare).toBeDefined();
    expect(tiles.get('visitors')?.delta.text).toMatch(/^[▴▾] [+−]\d/);
  });
});

describe('a bar list ranks what the server ranked', () => {
  it('keeps every row the answer carried, and every count', () => {
    const spec = widgetOf(site.dashboard, 'pages');
    const query = metricQueryOf(spec);
    const result = sliceOf(site, 'pages');
    const rows = barRows(result.rows, 'pageviews', 'path', '(none)');
    expect(rows.length).toBeGreaterThan(0);
    // The client merges campaign variants of a path (`/x?utm=…` → `/x`), so the
    // row count may shrink — but not one pageview may go missing in the merge.
    const answered = result.rows.reduce((sum, row) => sum + Number(row.pageviews ?? 0), 0);
    expect(rows.reduce((sum, row) => sum + row.value, 0)).toBe(answered);
    expect(rows.length).toBeLessThanOrEqual(result.rows.length);
    // …and the widget trims back to what it meant to show.
    expect(rows.slice(0, query.limit).length).toBeLessThanOrEqual(query.limit ?? 8);
  });

  it('reads the geo breakdown the corpus really has, unlocated group and all', () => {
    // This is what the geo fixture buys: until the replay had a geo provider
    // every country row was NULL, so the whole path — compiler, null group,
    // flag lookup — was exercised by one row that said nothing.
    const rows = barRows(sliceOf(site, 'countries').rows, 'visitors', 'country', 'Unknown');
    const named = rows.filter((row) => /^[A-Z]{2}$/.test(row.name));
    expect(named.length).toBeGreaterThan(1);
    expect(rows.some((row) => row.name === 'Unknown' && row.filterValue === null)).toBe(true);
  });

  it('labels the direct-traffic group and marks it for an is_null filter', () => {
    const rows = barRows(sliceOf(site, 'refs').rows, 'visitors', 'ref_domain', 'Direct');
    const direct = rows.find((row) => row.name === 'Direct');
    expect(direct?.filterValue).toBeNull();
    expect(direct?.value).toBeGreaterThan(0);
  });
});

describe('a time series draws the axis the server enumerated', () => {
  const spec = widgetOf(site.dashboard, 'series');
  const result = sliceOf(site, 'series');
  const axes = resultAxes(result, site.response.meta.windows, NOW);
  const points = seriesOf(result.rows, metricQueryOf(spec).metrics, sharedKeys(axes));

  it('has a point for every enumerated bucket and no bucket the server did not', () => {
    // Rows stay sparse on the wire; the client zips them against `axis` and
    // enumerates nothing itself (P1). A fabricated bucket is how a client-side
    // enumerator invented an hour that does not exist on spring-forward.
    const enumerated = new Set(sharedKeys(axes));
    expect(enumerated.size).toBeGreaterThan(1);
    expect(points.map((point) => point.bucket)).toEqual([...enumerated].sort());
    for (const row of result.rows) expect(enumerated.has(String(row.bucket))).toBe(true);
  });

  it('sums an additive metric back to the unbucketed total', () => {
    // `pageviews` is `aggregate: 'sum'`, so the buckets must add up to the KPI
    // row's own figure — the two queries ran in one snapshot and cannot disagree.
    const bucketed = points.reduce((sum, point) => sum + (point.values.pageviews ?? 0), 0);
    expect(bucketed).toBe(Number((sliceOf(site, 'kpis').rows[0] as ResultRow).pageviews));
  });
});

describe('time on page reads the session-scoped answer', () => {
  it('ranks by measured average and says what each average rests on', () => {
    const rows = dwellRows(sliceOf(site, 'dwell').rows);
    expect(rows.length).toBeGreaterThan(1);
    // The server ranked them; the client must not re-order into disagreement.
    expect(rows.map((row) => row.avgMs)).toEqual(
      [...rows.map((row) => row.avgMs)].sort((a, b) => b - a),
    );
    for (const row of rows) expect(row.views).toBeGreaterThan(0);
    expect(dwellBars(rows)[0]?.text).toMatch(/^\d+[smh]/);
  });
});

describe('the all-sites cards read totals the server counted once', () => {
  const all = allSitesAnswer();

  const totals = sliceOf(all, 'sites', 'totals');
  const buckets = sliceOf(all, 'sites');
  const stats = siteStats({
    totals: totals.rows,
    compare: totals.compare,
    buckets: buckets.rows,
    axes: resultAxes(buckets, all.response.meta.windows, NOW),
    sites: corpus.sites.map((one) => ({ ...one, domains: [...one.domains] })),
  });

  it('shows each site the same number that site’s own KPI tile shows', () => {
    // Defect 13, as the two screens that disagreed. The cards summed daily
    // visitor distincts while the tile deduped across the range, so one label
    // read two numbers — and neither package's own tests could see it, because
    // each was right about its own half. Same range, same clock, same server:
    // the card's headline and the site dashboard's tile have to agree.
    expect(stats.length).toBe(corpus.sites.length);
    for (const stat of stats) {
      const kpis = sliceOf(siteAnswer(stat.site), 'kpis').rows[0] as ResultRow;
      expect(stat.total, `site ${stat.site}`).toBeGreaterThan(0);
      expect(stat.total, `site ${stat.site}`).toBe(Number(kpis.visitors));
    }
  });

  it('never claims more visitors than its own buckets could hold', () => {
    // A distinct count has no total across buckets (`measureTotal` refuses one),
    // so the card reads its own `~totals` query. Summing the sparkline instead
    // can only over-count — a returning reader once per day they came back.
    for (const stat of stats) {
      const summed = stat.spark.reduce((sum, value) => sum + value, 0);
      expect(stat.total, `site ${stat.site}`).toBeLessThanOrEqual(summed);
      expect(summed).toBeGreaterThan(0);
    }
  });

  it('gives each card its own site’s axis, not the batch’s newest bucket', () => {
    const buckets = sliceOf(all, 'sites');
    const axes = resultAxes(buckets, all.response.meta.windows, NOW);
    expect(axes.length).toBe(corpus.sites.length);
    for (const axis of axes) expect(axis.keys.length).toBeGreaterThan(1);
  });
});

describe('the vocabulary the client knows is the vocabulary the server serves', () => {
  it('answers every metric of the shared enum, declares it, and labels it', () => {
    // `METRIC_LABELS` is exhaustive over `MetricSchema` by its type, and the KPI
    // tile writes by `measure.unit`. Neither says the SERVER can answer the
    // metric: a name added to the enum and not to the compiler type-checks on
    // both sides and fails only on a screen.
    const { response } = answer(vocabularyDashboard(), { site: CONTRACT_SITE });
    const answered: Record<string, Measure> = {};
    for (const entry of Object.values(response.results)) {
      if ('error' in entry) throw new Error(entry.error.message);
      Object.assign(answered, entry.measures);
    }
    expect(Object.keys(answered).sort()).toEqual([...MetricSchema.options].sort());
    for (const [metric, measure] of Object.entries(answered)) {
      expect(METRIC_LABELS[metric as Metric], metric).toBeTruthy();
      // Every unit the server emits is one the client can write.
      expect(formatMeasure(measure.unit, 1), metric).not.toBe('');
      expect(measure.aggregate === 'ratio', `${metric} 'of'`).toBe(measure.of !== undefined);
    }
  });
});

/** One widget per chunk of the metric enum — `MAX_METRICS_PER_QUERY` caps a query. */
function vocabularyDashboard(): Dashboard {
  const metrics = [...MetricSchema.options];
  const grid = [];
  for (let at = 0; at < metrics.length; at += MAX_METRICS_PER_QUERY) {
    const chunk = metrics.slice(at, at + MAX_METRICS_PER_QUERY);
    grid.push({
      id: `v${at}`,
      viz: 'kpi-row',
      w: 12,
      h: 1,
      options: {},
      query: { id: `v${at}`, metrics: chunk },
    });
  }
  return upgradeDashboard(DashboardSchema.parse({ name: 'Vocabulary', site: CONTRACT_SITE, grid }));
}
