import type { ResultRow, SiteInfo } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { addDaysIso } from './series.ts';
import { localToday, siteSortOf, siteStats, windowBuckets } from './site-stats.ts';

const TODAY = '2026-07-27';

/** Daily rows for one site: `values[k]` is the visitor count k days before today. */
function rowsFor(site: number, values: readonly number[]): ResultRow[] {
  return values.map((visitors, back) => ({
    bucket: addDaysIso(TODAY, -back),
    site,
    visitors,
  }));
}

function site(id: number, timezone = 'UTC'): SiteInfo {
  return { id, name: `Site ${id}`, domains: [], timezone };
}

/** Noon UTC on TODAY: the same calendar date in every timezone used below. */
const NOW = new Date(`${TODAY}T12:00:00Z`);

describe('windowBuckets', () => {
  it('enumerates the preset window in the site timezone', () => {
    const days = windowBuckets('7d', 'UTC', NOW);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe(addDaysIso(TODAY, -6));
    expect(days.at(-1)).toBe(TODAY);
  });

  it('enumerates today only up to the hour in progress, never the whole day', () => {
    // NOW is noon UTC: hours 00:00–12:00, and nothing from the future.
    const hours = windowBuckets('today', 'UTC', NOW);
    expect(hours).toHaveLength(13);
    expect(hours[0]).toBe(`${TODAY} 00:00`);
    expect(hours.at(-1)).toBe(`${TODAY} 12:00`);
  });

  it('follows the SITE clock, not the reader\u2019s', () => {
    // 12:00 UTC is 08:00 in New York: eight buckets there, thirteen in UTC.
    expect(windowBuckets('today', 'America/New_York', NOW)).toHaveLength(9);
  });
});

describe('siteStats', () => {
  it('totals the range, zero-fills the spark, and takes the previous-period delta', () => {
    const rows: ResultRow[] = [
      { bucket: TODAY, site: 1, visitors: 120 },
      { bucket: addDaysIso(TODAY, -6), site: 1, visitors: 30 },
    ];
    const compare: ResultRow[] = [
      { bucket: addDaysIso(TODAY, -8), site: 1, visitors: 60 },
      { bucket: addDaysIso(TODAY, -9), site: 1, visitors: 40 },
    ];
    const [stat] = siteStats('7d', rows, compare, [site(1)], NOW);
    expect(stat?.total).toBe(150);
    expect(stat?.spark).toEqual([30, 0, 0, 0, 0, 0, 120]);
    expect(stat?.deltaPct).toBe(50); // 150 vs 100
  });

  it('withholds the delta unless both periods have traffic', () => {
    const [noPrev] = siteStats('7d', rowsFor(3, [50, 40]), [], [site(3)], NOW);
    expect(noPrev?.deltaPct).toBeUndefined();
    const [noNow] = siteStats(
      '7d',
      [],
      [{ bucket: addDaysIso(TODAY, -8), site: 3, visitors: 9 }],
      [site(3)],
      NOW,
    );
    expect(noNow?.deltaPct).toBeUndefined();
  });

  it('buckets each site by its OWN window: one site past midnight must not zero the others', () => {
    // 23:30 UTC on the 27th: Berlin (UTC+2) is already on the 28th, UTC is not.
    const lateNight = new Date('2026-07-27T23:30:00Z');
    const rows: ResultRow[] = [
      { bucket: '2026-07-27', site: 1, visitors: 28 },
      { bucket: '2026-07-28', site: 2, visitors: 5 },
      { bucket: '2026-07-27', site: 2, visitors: 20 },
    ];
    const stats = siteStats('7d', rows, [], [site(1, 'UTC'), site(2, 'Europe/Berlin')], lateNight);
    const one = stats.find((stat) => stat.site === 1);
    const two = stats.find((stat) => stat.site === 2);
    expect(one?.buckets.at(-1)).toBe('2026-07-27');
    expect(one?.spark.at(-1)).toBe(28); // NOT zeroed by Berlin's new day
    expect(two?.buckets.at(-1)).toBe('2026-07-28');
    expect(two?.spark.at(-1)).toBe(5);
    expect(two?.total).toBe(25); // both its days sit inside its own window
  });

  it('gives a rowless site a silent card instead of making it invisible', () => {
    const stats = siteStats('7d', rowsFor(1, [30]), [], [site(1), site(7)], NOW);
    expect(stats.map((stat) => stat.site)).toEqual([1, 7]);
    const fresh = stats[1];
    expect(fresh?.silent).toBe(true);
    expect(fresh?.total).toBe(0);
    expect(fresh?.spark).toEqual(Array(7).fill(0));
    expect(stats[0]?.silent).toBe(false);
  });

  it('sorts by range total under the default traffic sort', () => {
    const rows = [...rowsFor(3, [90]), ...rowsFor(1, [10, 95]), ...rowsFor(2, [50])];
    expect(siteStats('7d', rows, [], undefined, NOW).map((stat) => stat.site)).toEqual([1, 3, 2]);
  });

  it('sorts by site id when asked (docs/05: fixed by site id)', () => {
    const rows = [...rowsFor(3, [90]), ...rowsFor(1, [10]), ...rowsFor(2, [50])];
    expect(siteStats('7d', rows, [], undefined, NOW, 'id').map((stat) => stat.site)).toEqual([
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
    expect(siteStats('7d', rows, [], directory, NOW, 'name').map((stat) => stat.site)).toEqual([
      2, 3, 1,
    ]);
  });

  it('returns nothing for no rows and no directory', () => {
    expect(siteStats('30d', [], [], undefined, NOW)).toEqual([]);
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

describe('localToday', () => {
  it('formats the site-local date', () => {
    expect(localToday('UTC', NOW)).toBe(TODAY);
    expect(localToday('Asia/Tokyo', new Date('2026-07-27T23:30:00Z'))).toBe('2026-07-28');
  });
});
