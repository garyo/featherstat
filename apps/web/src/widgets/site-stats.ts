import type { ResultRow, SiteInfo } from '@featherstat/shared';
import type { ViewAxis } from './axis.ts';
import { num } from './series.ts';

/**
 * Shapes the all-sites cards from one `visitors × day × site` result. Each
 * card's window is that site's OWN, taken from the per-site axis the server
 * enumerated for the result — the shared batch spans timezones, and reading
 * every site at the globally newest bucket zeroes whole cards for hours around
 * midnight. The delta compares the previous period (server `compare`), which
 * rides the same result — no second query.
 */

/** Card order (docs/05): traffic (default, site-id tiebreak), fixed by id, or name. */
export type SiteSort = 'traffic' | 'id' | 'name';

/** Widget-options value → sort, anything unrecognized falling back to traffic. */
export function siteSortOf(raw: unknown): SiteSort {
  return raw === 'id' || raw === 'name' ? raw : 'traffic';
}

export interface SiteStat {
  site: number;
  /** This site's own axis keys (dates; hours under `today`), as the server enumerated them. */
  buckets: string[];
  /** Visitors over the selected range. */
  total: number;
  /** vs the previous period (server compare); needs both sides to be signal. */
  deltaPct: number | undefined;
  /** Visitors per bucket over the range, zero-filled, oldest first. */
  spark: number[];
  silent: boolean;
}

export function siteStats(
  axes: readonly ViewAxis[],
  rows: readonly ResultRow[],
  compareRows: readonly ResultRow[] | undefined,
  sites?: readonly SiteInfo[],
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
  const axisOf = new Map(axes.map((axis) => [axis.siteId, axis.keys]));
  const stats: SiteStat[] = [];
  for (const site of ids) {
    const values = bySite.get(site);
    const buckets = axisOf.get(site) ?? [];
    const spark = buckets.map((bucket) => values?.get(bucket) ?? 0);
    // Summed over the ROWS, not the spark: SQL already bounded them to this
    // site's window, so the figure stands even when the axis is withheld.
    let total = 0;
    for (const value of values?.values() ?? []) total += value;
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
