import type { ResultRow, SiteInfo } from '@featherstat/shared';
import type { RangePreset } from '../lib/state.ts';
import { currentHourBucket, presetWindow } from './format.ts';
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

/** Card order (docs/05): traffic (default, site-id tiebreak), fixed by id, or name. */
export type SiteSort = 'traffic' | 'id' | 'name';

/** Widget-options value → sort, anything unrecognized falling back to traffic. */
export function siteSortOf(raw: unknown): SiteSort {
  return raw === 'id' || raw === 'name' ? raw : 'traffic';
}

/**
 * A site's own current date, from its IANA timezone — en-CA formats as
 * YYYY-MM-DD. Cached per zone: Intl.DateTimeFormat construction is expensive.
 */
const dateFormats = new Map<string, Intl.DateTimeFormat>();
export function localToday(timezone: string, now: Date = new Date()): string {
  let format = dateFormats.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    dateFormats.set(timezone, format);
  }
  return format.format(now);
}

export interface SiteStat {
  site: number;
  /** Enumerated bucket keys of this site's requested window (dates; hours under `today`). */
  buckets: string[];
  /** Visitors over the selected range. */
  total: number;
  /** vs the previous period (server compare); needs both sides to be signal. */
  deltaPct: number | undefined;
  /** Visitors per bucket over the range, zero-filled, oldest first. */
  spark: number[];
  silent: boolean;
}

/** The card grid's bucket clock: one key per bucket of the site's own window. */
export function windowBuckets(preset: RangePreset, timezone: string, now: Date): string[] {
  const { from, to } = presetWindow(preset, timezone, now);
  if (preset === 'today') {
    // Up to and including the hour in progress — never the whole calendar day.
    const last = Number(currentHourBucket(timezone, now).slice(11, 13));
    return Array.from(
      { length: last + 1 },
      (_, hour) => `${to} ${String(hour).padStart(2, '0')}:00`,
    );
  }
  const buckets: string[] = [];
  for (let day = from; day <= to; day = addDaysIso(day, 1)) buckets.push(day);
  return buckets;
}

export function siteStats(
  preset: RangePreset,
  rows: readonly ResultRow[],
  compareRows: readonly ResultRow[] | undefined,
  sites?: readonly SiteInfo[],
  now: Date = new Date(),
  sort: SiteSort = 'traffic',
): SiteStat[] {
  const bySite = new Map<number, Map<string, number>>();
  for (const row of rows) {
    const site = row.site;
    const bucket = row.bucket;
    if (typeof site !== 'number' || typeof bucket !== 'string') continue;
    let buckets = bySite.get(site);
    if (buckets === undefined) {
      buckets = new Map();
      bySite.set(site, buckets);
    }
    buckets.set(bucket, num(row.visitors));
  }
  const prevTotals = new Map<number, number>();
  for (const row of compareRows ?? []) {
    if (typeof row.site !== 'number') continue;
    prevTotals.set(row.site, (prevTotals.get(row.site) ?? 0) + num(row.visitors));
  }

  const ids = sites?.map((site) => site.id) ?? [...bySite.keys()];
  const tzOf = new Map(sites?.map((site) => [site.id, site.timezone]) ?? []);
  const stats: SiteStat[] = [];
  for (const site of ids) {
    const values = bySite.get(site);
    const buckets = windowBuckets(preset, tzOf.get(site) ?? 'UTC', now);
    const spark = buckets.map((bucket) => values?.get(bucket) ?? 0);
    const total = spark.reduce((sum, value) => sum + value, 0);
    const prev = prevTotals.get(site) ?? 0;
    stats.push({
      site,
      buckets,
      total,
      spark,
      // Both sides required: a brand-new (or just-quiet) period reads as "—",
      // not a red −100% — same reasoning the old same-weekday delta used.
      deltaPct: total > 0 && prev > 0 ? Math.round(((total - prev) / prev) * 100) : undefined,
      silent: values === undefined || values.size === 0,
    });
  }
  if (sort === 'id') {
    stats.sort((a, b) => a.site - b.site);
  } else if (sort === 'name') {
    const names = new Map(sites?.map((site) => [site.id, site.name]) ?? []);
    const nameOf = (id: number): string => names.get(id) ?? `Site ${id}`;
    stats.sort((a, b) => nameOf(a.site).localeCompare(nameOf(b.site)) || a.site - b.site);
  } else {
    stats.sort((a, b) => b.total - a.total || a.site - b.site);
  }
  return stats;
}
