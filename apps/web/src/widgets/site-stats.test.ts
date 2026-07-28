import type { ResultRow, SiteInfo } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { addDaysIso } from './series.ts';
import { localToday, SPARK_DAYS, siteSortOf, siteStats } from './site-stats.ts';

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

describe('siteStats', () => {
  it('reads today, the same-weekday-last-week delta, and a zero-filled spark', () => {
    // Site 1: 120 today, 100 a week ago, nothing on the days between.
    const rows: ResultRow[] = [
      { bucket: TODAY, site: 1, visitors: 120 },
      { bucket: addDaysIso(TODAY, -7), site: 1, visitors: 100 },
    ];
    const [stat] = siteStats(rows);
    expect(stat?.site).toBe(1);
    expect(stat?.todayVisitors).toBe(120);
    expect(stat?.deltaPct).toBe(20);
    expect(stat?.spark).toHaveLength(SPARK_DAYS);
    expect(stat?.spark[SPARK_DAYS - 1]).toBe(120);
    expect(stat?.spark[SPARK_DAYS - 8]).toBe(100);
    expect(stat?.spark[SPARK_DAYS - 2]).toBe(0); // gap day, zero-filled
  });

  it('leaves the delta undefined without a baseline', () => {
    const [stat] = siteStats(rowsFor(3, [50, 40]));
    expect(stat?.deltaPct).toBeUndefined();
  });

  it('sorts by traffic: today first, then window total', () => {
    const rows = [
      ...rowsFor(1, [10, 500]), // big yesterday, quiet today
      ...rowsFor(2, [80, 5]),
      ...rowsFor(3, [10, 20]),
    ];
    expect(siteStats(rows).map((stat) => stat.site)).toEqual([2, 1, 3]);
  });

  it('answers a site that was quiet today with zeros, not a missing card', () => {
    const rows = [...rowsFor(1, [30]), ...rowsFor(2, [0, 60]).slice(1)];
    const stats = siteStats(rows);
    expect(stats.map((stat) => stat.site)).toEqual([1, 2]);
    expect(stats[1]?.todayVisitors).toBe(0);
    // A day with no traffic yet has no delta signal — never a red −100%.
    expect(stats[1]?.deltaPct).toBeUndefined();
  });

  it('returns nothing for no rows and no directory', () => {
    expect(siteStats([])).toEqual([]);
  });

  it("uses each site's OWN local today: one site past midnight must not zero the others", () => {
    // 23:30 UTC on the 27th: Berlin (UTC+2) is already on the 28th, UTC is not.
    const lateNight = new Date('2026-07-27T23:30:00Z');
    const rows: ResultRow[] = [
      { bucket: '2026-07-27', site: 1, visitors: 28 }, // UTC site, busy "today"
      { bucket: '2026-07-28', site: 2, visitors: 5 }, // Berlin site, 5 after ITS midnight
      { bucket: '2026-07-27', site: 2, visitors: 20 },
    ];
    const stats = siteStats(rows, [site(1, 'UTC'), site(2, 'Europe/Berlin')], lateNight);
    const one = stats.find((stat) => stat.site === 1);
    const two = stats.find((stat) => stat.site === 2);
    expect(one?.today).toBe('2026-07-27');
    expect(one?.todayVisitors).toBe(28); // NOT zeroed by Berlin's new day
    expect(two?.today).toBe('2026-07-28');
    expect(two?.todayVisitors).toBe(5);
  });

  it('gives a rowless site a silent card instead of making it invisible', () => {
    const stats = siteStats(rowsFor(1, [30]), [site(1), site(7)], NOW);
    expect(stats.map((stat) => stat.site)).toEqual([1, 7]);
    const fresh = stats[1];
    expect(fresh?.silent).toBe(true);
    expect(fresh?.todayVisitors).toBe(0);
    expect(fresh?.spark).toEqual(Array(SPARK_DAYS).fill(0));
    expect(stats[0]?.silent).toBe(false);
  });

  it('sorts by site id when asked (docs/05: fixed by site id)', () => {
    const rows = [...rowsFor(3, [90]), ...rowsFor(1, [10]), ...rowsFor(2, [50])];
    expect(siteStats(rows, undefined, NOW, 'id').map((stat) => stat.site)).toEqual([1, 2, 3]);
  });

  it('sorts by name with a site-id tiebreak', () => {
    const rows = [...rowsFor(1, [10]), ...rowsFor(2, [90]), ...rowsFor(3, [50])];
    const directory: SiteInfo[] = [
      { id: 1, name: 'zeta', domains: [], timezone: 'UTC' },
      { id: 2, name: 'alpha', domains: [], timezone: 'UTC' },
      { id: 3, name: 'alpha', domains: [], timezone: 'UTC' }, // duplicate name → id decides
    ];
    expect(siteStats(rows, directory, NOW, 'name').map((stat) => stat.site)).toEqual([2, 3, 1]);
  });
});

describe('siteSortOf', () => {
  it('accepts the vocabulary and falls back to traffic on junk', () => {
    expect(siteSortOf('id')).toBe('id');
    expect(siteSortOf('name')).toBe('name');
    expect(siteSortOf('traffic')).toBe('traffic');
    expect(siteSortOf('bogus')).toBe('traffic');
    expect(siteSortOf(undefined)).toBe('traffic');
  });
});

describe('localToday', () => {
  it('formats the date in the site timezone', () => {
    const lateNight = new Date('2026-07-27T23:30:00Z');
    expect(localToday('UTC', lateNight)).toBe('2026-07-27');
    expect(localToday('Europe/Berlin', lateNight)).toBe('2026-07-28');
    expect(localToday('America/Los_Angeles', lateNight)).toBe('2026-07-27');
  });

  it('degrades to UTC on a garbage timezone', () => {
    expect(localToday('Not/AZone', new Date('2026-07-27T23:30:00Z'))).toBe('2026-07-27');
  });
});
