import type { ResultRow, SiteInfo } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import type { ViewAxis } from './axis.ts';
import { siteSortOf, siteStats } from './site-stats.ts';

const TODAY = '2026-07-27';
const DAY_MS = 86_400_000;

const dayBefore = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

/** Daily rows for one site: `values[k]` is the visitor count k days before today. */
function rowsFor(site: number, values: readonly number[]): ResultRow[] {
  return values.map((visitors, back) => ({ bucket: dayBefore(back), site, visitors }));
}

function site(id: number): SiteInfo {
  return { id, name: `Site ${id}`, domains: [], timezone: 'UTC' };
}

/** The server's per-site axis for a 7-day window ending on TODAY. */
function week(...ids: number[]): ViewAxis[] {
  const keys = Array.from({ length: 7 }, (_, i) => dayBefore(6 - i));
  return ids.map((siteId) => ({ siteId, keys }));
}

describe('siteStats', () => {
  it('totals the range, zero-fills the spark, and takes the previous-period delta', () => {
    const rows: ResultRow[] = [
      { bucket: TODAY, site: 1, visitors: 120 },
      { bucket: dayBefore(6), site: 1, visitors: 30 },
    ];
    const compare: ResultRow[] = [
      { bucket: dayBefore(8), site: 1, visitors: 60 },
      { bucket: dayBefore(9), site: 1, visitors: 40 },
    ];
    const [stat] = siteStats(week(1), rows, compare, [site(1)]);
    expect(stat?.total).toBe(150);
    expect(stat?.spark).toEqual([30, 0, 0, 0, 0, 0, 120]);
    expect(stat?.deltaPct).toBe(50); // 150 vs 100
  });

  it('withholds the delta unless both periods have traffic', () => {
    const [noPrev] = siteStats(week(3), rowsFor(3, [50, 40]), [], [site(3)]);
    expect(noPrev?.deltaPct).toBeUndefined();
    const [noNow] = siteStats(
      week(3),
      [],
      [{ bucket: dayBefore(8), site: 3, visitors: 9 }],
      [site(3)],
    );
    expect(noNow?.deltaPct).toBeUndefined();
  });

  it('buckets each site by its OWN axis: one site past midnight must not zero the others', () => {
    // 23:30 UTC on the 27th: Berlin (UTC+2) is already on the 28th, UTC is not,
    // and the server said so — one axis per site in `result.axis`.
    const axes: ViewAxis[] = [
      { siteId: 1, keys: ['2026-07-26', '2026-07-27'] },
      { siteId: 2, keys: ['2026-07-27', '2026-07-28'] },
    ];
    const rows: ResultRow[] = [
      { bucket: '2026-07-27', site: 1, visitors: 28 },
      { bucket: '2026-07-28', site: 2, visitors: 5 },
      { bucket: '2026-07-27', site: 2, visitors: 20 },
    ];
    const stats = siteStats(axes, rows, [], [site(1), site(2)]);
    const one = stats.find((stat) => stat.site === 1);
    const two = stats.find((stat) => stat.site === 2);
    expect(one?.buckets.at(-1)).toBe('2026-07-27');
    expect(one?.spark.at(-1)).toBe(28); // NOT zeroed by Berlin's new day
    expect(two?.buckets.at(-1)).toBe('2026-07-28');
    expect(two?.spark.at(-1)).toBe(5);
    expect(two?.total).toBe(25); // both its days sit inside its own window
  });

  it('gives a rowless site a silent card instead of making it invisible', () => {
    const stats = siteStats(week(1, 7), rowsFor(1, [30]), [], [site(1), site(7)]);
    expect(stats.map((stat) => stat.site)).toEqual([1, 7]);
    const fresh = stats[1];
    expect(fresh?.silent).toBe(true);
    expect(fresh?.total).toBe(0);
    expect(fresh?.spark).toEqual(Array(7).fill(0));
    expect(stats[0]?.silent).toBe(false);
  });

  it('keeps the total when the server withheld the axis, losing only the spark', () => {
    const [stat] = siteStats([], rowsFor(1, [30, 20]), [], [site(1)]);
    expect(stat?.total).toBe(50);
    expect(stat?.spark).toEqual([]);
  });

  it('sorts by range total under the default traffic sort', () => {
    const rows = [...rowsFor(3, [90]), ...rowsFor(1, [10, 95]), ...rowsFor(2, [50])];
    expect(siteStats(week(1, 2, 3), rows, [], undefined).map((stat) => stat.site)).toEqual([
      1, 3, 2,
    ]);
  });

  it('sorts by site id when asked (docs/05: fixed by site id)', () => {
    const rows = [...rowsFor(3, [90]), ...rowsFor(1, [10]), ...rowsFor(2, [50])];
    expect(siteStats(week(1, 2, 3), rows, [], undefined, 'id').map((stat) => stat.site)).toEqual([
      1, 2, 3,
    ]);
  });

  it('sorts by name with a site-id tiebreak', () => {
    const rows = [...rowsFor(1, [10]), ...rowsFor(2, [90]), ...rowsFor(3, [50])];
    const directory: SiteInfo[] = [
      { id: 1, name: 'zeta', domains: [], timezone: 'UTC' },
      { id: 2, name: 'alpha', domains: [], timezone: 'UTC' },
      { id: 3, name: 'alpha', domains: [], timezone: 'UTC' }, // duplicate name → id decides
    ];
    expect(siteStats(week(1, 2, 3), rows, [], directory, 'name').map((stat) => stat.site)).toEqual([
      2, 3, 1,
    ]);
  });

  it('returns nothing for no rows and no directory', () => {
    expect(siteStats([], [], [], undefined)).toEqual([]);
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
