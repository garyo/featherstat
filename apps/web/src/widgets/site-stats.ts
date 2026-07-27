import type { ResultRow } from '@analytics/shared';
import { addDaysIso, num } from './series.ts';

/**
 * Shapes the all-sites cards from one `visitors × day × site` result. "Today"
 * is the newest local date any site reported; per-site local todays can differ
 * around midnight, which M0 accepts as the price of one shared batch. The
 * delta compares the same weekday last week (mockup: "deltas vs the same day
 * last week"), which the daily series already contains — no second query.
 */

export const SPARK_DAYS = 14;

export interface SiteStat {
  site: number;
  today: number;
  /** Integer percent vs the same weekday last week; undefined without a baseline. */
  deltaPct: number | undefined;
  /** Daily visitors for the last `SPARK_DAYS` days, ending today, zero-filled. */
  spark: number[];
  /** Window total — the docs/05 sort key ("sorted by traffic") behind equal todays. */
  total: number;
}

export function siteStats(rows: readonly ResultRow[]): SiteStat[] {
  const bySite = new Map<number, Map<string, number>>();
  let today: string | undefined;
  for (const row of rows) {
    const site = row.site;
    const bucket = row.bucket;
    if (typeof site !== 'number' || typeof bucket !== 'string') continue;
    let dates = bySite.get(site);
    if (dates === undefined) {
      dates = new Map();
      bySite.set(site, dates);
    }
    dates.set(bucket, num(row.visitors));
    if (today === undefined || bucket > today) today = bucket;
  }
  if (today === undefined) return [];

  const stats: SiteStat[] = [];
  for (const [site, dates] of bySite) {
    const spark: number[] = [];
    for (let back = SPARK_DAYS - 1; back >= 0; back--) {
      spark.push(dates.get(addDaysIso(today, -back)) ?? 0);
    }
    const current = spark[spark.length - 1] ?? 0;
    const prev = dates.get(addDaysIso(today, -7)) ?? 0;
    let total = 0;
    for (const value of dates.values()) total += value;
    stats.push({
      site,
      today: current,
      deltaPct: prev > 0 ? Math.round(((current - prev) / prev) * 100) : undefined,
      spark,
      total,
    });
  }
  stats.sort((a, b) => b.today - a.today || b.total - a.total || a.site - b.site);
  return stats;
}
