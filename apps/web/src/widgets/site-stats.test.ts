import type { ResultRow, SiteInfo } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import type { ViewAxis } from './axis.ts';
import { type SiteStatsInput, siteSortOf, siteStats } from './site-stats.ts';

const TODAY = '2026-07-27';
const DAY_MS = 86_400_000;

const dayBefore = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

/** Daily rows for one site: `values[k]` is the visitor count k days before today. */
function rowsFor(site: number, values: readonly number[]): ResultRow[] {
  return values.map((visitors, back) => ({ bucket: dayBefore(back), site, visitors }));
}

/** The unbucketed `visitors × site` companion — the server's range count. */
function totalsFor(...pairs: readonly [number, number][]): ResultRow[] {
  return pairs.map(([site, visitors]) => ({ site, visitors }));
}

function site(id: number): SiteInfo {
  return { id, name: `Site ${id}`, domains: [], timezone: 'UTC' };
}

/** The server's per-site axis for a 7-day window ending on TODAY. */
function week(...ids: number[]): ViewAxis[] {
  const keys = Array.from({ length: 7 }, (_, i) => dayBefore(6 - i));
  return ids.map((siteId) => ({ siteId, keys }));
}

function stats(input: Partial<SiteStatsInput> = {}) {
  return siteStats({ axes: [], totals: [], compare: undefined, buckets: [], ...input });
}

describe('siteStats', () => {
  it('takes the total from the server, zero-fills the spark, and deltas the previous period', () => {
    const [stat] = stats({
      axes: week(1),
      totals: totalsFor([1, 150]),
      compare: totalsFor([1, 100]),
      buckets: [
        { bucket: TODAY, site: 1, visitors: 120 },
        { bucket: dayBefore(6), site: 1, visitors: 30 },
      ],
      sites: [site(1)],
    });
    expect(stat?.total).toBe(150);
    expect(stat?.spark).toEqual([30, 0, 0, 0, 0, 0, 120]);
    expect(stat?.deltaPct).toBe(50); // 150 vs 100
  });

  /**
   * Defect 13, as a test. `visitors` is a distinct count: over a multi-day range
   * the buckets sum to MORE than the range's own answer, because a reader who
   * came back on two days is two visitor-days and one visitor. This card used to
   * print the sum and the site's KPI tile printed the range count — two screens,
   * two numbers, one label.
   */
  it('never sums a distinct count across buckets: the card matches the KPI tile', () => {
    const [stat] = stats({
      axes: week(1),
      // The server's range answer: 7 people, some of whom came back.
      totals: totalsFor([1, 7]),
      buckets: rowsFor(1, [4, 3, 3]), // 10 visitor-days
      sites: [site(1)],
    });
    expect(stat?.total).toBe(7);
    expect(stat?.spark.reduce((sum, value) => sum + value, 0)).toBe(10);
  });

  it('withholds the delta unless both periods have traffic', () => {
    const noPrev = stats({
      axes: week(3),
      totals: totalsFor([3, 90]),
      compare: [],
      buckets: rowsFor(3, [50, 40]),
      sites: [site(3)],
    })[0];
    expect(noPrev?.deltaPct).toBeUndefined();
    const noNow = stats({
      axes: week(3),
      totals: [],
      compare: totalsFor([3, 9]),
      sites: [site(3)],
    })[0];
    expect(noNow?.deltaPct).toBeUndefined();
  });

  it('buckets each site by its OWN axis: one site past midnight must not zero the others', () => {
    // 23:30 UTC on the 27th: Berlin (UTC+2) is already on the 28th, UTC is not,
    // and the server said so — one axis per site in `result.axis`.
    const axes: ViewAxis[] = [
      { siteId: 1, keys: ['2026-07-26', '2026-07-27'] },
      { siteId: 2, keys: ['2026-07-27', '2026-07-28'] },
    ];
    const result = stats({
      axes,
      totals: totalsFor([1, 28], [2, 25]),
      buckets: [
        { bucket: '2026-07-27', site: 1, visitors: 28 },
        { bucket: '2026-07-28', site: 2, visitors: 5 },
        { bucket: '2026-07-27', site: 2, visitors: 20 },
      ],
      sites: [site(1), site(2)],
    });
    const one = result.find((stat) => stat.site === 1);
    const two = result.find((stat) => stat.site === 2);
    expect(one?.buckets.at(-1)).toBe('2026-07-27');
    expect(one?.spark.at(-1)).toBe(28); // NOT zeroed by Berlin's new day
    expect(two?.buckets.at(-1)).toBe('2026-07-28');
    expect(two?.spark.at(-1)).toBe(5);
    expect(two?.total).toBe(25); // both its days sit inside its own window
  });

  it('gives a rowless site a silent card instead of making it invisible', () => {
    const result = stats({
      axes: week(1, 7),
      totals: totalsFor([1, 30]),
      buckets: rowsFor(1, [30]),
      sites: [site(1), site(7)],
    });
    expect(result.map((stat) => stat.site)).toEqual([1, 7]);
    const fresh = result[1];
    expect(fresh?.silent).toBe(true);
    expect(fresh?.total).toBe(0);
    expect(fresh?.spark).toEqual(Array(7).fill(0));
    expect(result[0]?.silent).toBe(false);
  });

  it('keeps the total when the server withheld the axis, losing only the spark', () => {
    const [stat] = stats({
      totals: totalsFor([1, 50]),
      buckets: rowsFor(1, [30, 20]),
      sites: [site(1)],
    });
    expect(stat?.total).toBe(50);
    expect(stat?.spark).toEqual([]);
  });

  it('sorts by range total under the default traffic sort', () => {
    const result = stats({
      axes: week(1, 2, 3),
      totals: totalsFor([3, 90], [1, 105], [2, 50]),
      buckets: [...rowsFor(3, [90]), ...rowsFor(1, [10, 95]), ...rowsFor(2, [50])],
    });
    expect(result.map((stat) => stat.site)).toEqual([1, 3, 2]);
  });

  it('sorts by site id when asked (docs/05: fixed by site id)', () => {
    const result = stats({
      axes: week(1, 2, 3),
      totals: totalsFor([3, 90], [1, 10], [2, 50]),
      sort: 'id',
    });
    expect(result.map((stat) => stat.site)).toEqual([1, 2, 3]);
  });

  it('sorts by name with a site-id tiebreak', () => {
    const directory: SiteInfo[] = [
      { id: 1, name: 'zeta', domains: [], timezone: 'UTC' },
      { id: 2, name: 'alpha', domains: [], timezone: 'UTC' },
      { id: 3, name: 'alpha', domains: [], timezone: 'UTC' }, // duplicate name → id decides
    ];
    const result = stats({
      axes: week(1, 2, 3),
      totals: totalsFor([1, 10], [2, 90], [3, 50]),
      sites: directory,
      sort: 'name',
    });
    expect(result.map((stat) => stat.site)).toEqual([2, 3, 1]);
  });

  it('returns nothing for no rows and no directory', () => {
    expect(stats()).toEqual([]);
  });
});

describe('siteSortOf', () => {
  it('accepts the three sorts and falls back to traffic', () => {
    expect(siteSortOf('id')).toBe('id');
    expect(siteSortOf('name')).toBe('name');
    expect(siteSortOf('bogus')).toBe('traffic');
    expect(siteSortOf(undefined)).toBe('traffic');
  });
});
