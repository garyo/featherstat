import type { ResultRow, SiteInfo } from '@analytics/shared';
import { addDaysIso, num } from './series.ts';

/**
 * Shapes the all-sites cards from one `visitors × day × site` result. Each
 * card's "today" is that site's OWN local today (from its IANA timezone in the
 * site directory) — the shared batch spans timezones, and reading every site
 * at the globally newest bucket zeroes whole cards for hours around midnight.
 * The delta compares the same weekday last week (mockup: "deltas vs the same
 * day last week"), which the daily series already contains — no second query.
 */

export const SPARK_DAYS = 14;

export interface SiteStat {
  site: number;
  /** This site's local today — also the clock its page trends end on. */
  today: string;
  todayVisitors: number;
  /** Integer percent vs the same weekday last week; undefined without a baseline. */
  deltaPct: number | undefined;
  /** Daily visitors for the last `SPARK_DAYS` days, ending today, zero-filled. */
  spark: number[];
  /** Window total — the docs/05 sort key ("sorted by traffic") behind equal todays. */
  total: number;
  /** True when the window returned no rows at all — "waiting for the first hit". */
  silent: boolean;
}

/** The newest bucket any row reported — the fallback clock when the directory is absent. */
export function newestBucket(rows: readonly ResultRow[]): string | undefined {
  let newest: string | undefined;
  for (const row of rows) {
    const bucket = row.bucket;
    if (typeof bucket !== 'string') continue;
    if (newest === undefined || bucket > newest) newest = bucket;
  }
  return newest;
}

/** `YYYY-MM-DD` of "now" in an IANA timezone; UTC if the runtime rejects it. */
export function localToday(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * One stat per site. With the directory present, every site gets a card — a
 * freshly added site shows as silent instead of invisible, which is exactly
 * when a mis-installed snippet needs spotting.
 */
export function siteStats(
  rows: readonly ResultRow[],
  sites?: readonly SiteInfo[],
  now: Date = new Date(),
): SiteStat[] {
  const bySite = new Map<number, Map<string, number>>();
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
  }

  const fallbackToday = newestBucket(rows);
  const todayOf = new Map<number, string>();
  if (sites !== undefined) {
    for (const site of sites) todayOf.set(site.id, localToday(site.timezone, now));
  }
  const ids = sites?.map((site) => site.id) ?? [...bySite.keys()];

  const stats: SiteStat[] = [];
  for (const site of ids) {
    const dates = bySite.get(site);
    const today = todayOf.get(site) ?? fallbackToday;
    if (today === undefined) continue; // no directory and no rows: nothing to anchor on
    const spark: number[] = [];
    for (let back = SPARK_DAYS - 1; back >= 0; back--) {
      spark.push(dates?.get(addDaysIso(today, -back)) ?? 0);
    }
    const current = spark[spark.length - 1] ?? 0;
    const prev = dates?.get(addDaysIso(today, -7)) ?? 0;
    let total = 0;
    for (const value of dates?.values() ?? []) total += value;
    stats.push({
      site,
      today,
      todayVisitors: current,
      // No traffic YET is the normal state just after site-local midnight —
      // a red "−100%" there is noise, not signal. Delta needs both sides.
      deltaPct: current > 0 && prev > 0 ? Math.round(((current - prev) / prev) * 100) : undefined,
      spark,
      total,
      silent: dates === undefined || dates.size === 0,
    });
  }
  stats.sort((a, b) => b.todayVisitors - a.todayVisitors || b.total - a.total || a.site - b.site);
  return stats;
}
