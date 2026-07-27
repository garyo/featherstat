import type { ResultRow } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { addDaysIso } from './series.ts';
import { SPARK_DAYS, siteStats } from './site-stats.ts';

const TODAY = '2026-07-27';

/** Daily rows for one site: `values[k]` is the visitor count k days before today. */
function rowsFor(site: number, values: readonly number[]): ResultRow[] {
  return values.map((visitors, back) => ({
    bucket: addDaysIso(TODAY, -back),
    site,
    visitors,
  }));
}

describe('siteStats', () => {
  it('reads today, the same-weekday-last-week delta, and a zero-filled spark', () => {
    // Site 1: 120 today, 100 a week ago, nothing on the days between.
    const rows: ResultRow[] = [
      { bucket: TODAY, site: 1, visitors: 120 },
      { bucket: addDaysIso(TODAY, -7), site: 1, visitors: 100 },
    ];
    const [stat] = siteStats(rows);
    expect(stat?.site).toBe(1);
    expect(stat?.today).toBe(120);
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
    expect(stats[1]?.today).toBe(0);
  });

  it('returns nothing for no rows', () => {
    expect(siteStats([])).toEqual([]);
  });
});
