import type { ResultRow, SiteInfo } from '@featherstat/shared';
import type { ViewAxis } from './axis.ts';
import { num } from './series.ts';

/**
 * Shapes the all-sites cards from two results of the same batch: one
 * `visitors × site` total and one `visitors × day × site` series.
 *
 * Two results and not one, because `visitors` is a distinct count
 * (`aggregate: 'distinct'`) and a distinct count has no total across buckets.
 * Summing the day rows — which this did — counts a reader who came back on
 * Tuesday twice, so the same "visitors" label read one number on a card and a
 * smaller one on that site's KPI tile (defect 13). The server counts the range
 * once; the buckets are the sparkline's shape and nothing else.
 *
 * Each card's window is that site's OWN, taken from the per-site axis the server
 * enumerated — the shared batch spans timezones, and reading every site at the
 * globally newest bucket zeroes whole cards for hours around midnight. The delta
 * compares the previous period (server `compare`), which rides the same result.
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
  /** Visitors over the selected range, counted once by the server. */
  total: number;
  /** vs the previous period (server compare); needs both sides to be signal. */
  deltaPct: number | undefined;
  /** Visitors per bucket over the range, zero-filled, oldest first. */
  spark: number[];
  silent: boolean;
}

export interface SiteStatsInput {
  /** Per-site totals over the whole range — the card's headline number. */
  totals: readonly ResultRow[];
  /** The same, over the previous period. */
  compare: readonly ResultRow[] | undefined;
  /** Per-site × bucket rows — the sparkline's shape only. */
  buckets: readonly ResultRow[];
  /** The bucketed result's per-site axes, already trimmed to the reader's clock. */
  axes: readonly ViewAxis[];
  /** The site directory: which cards exist, and their names for the name sort. */
  sites?: readonly SiteInfo[];
  sort?: SiteSort;
}

export function siteStats(input: SiteStatsInput): SiteStat[] {
  const bySite = new Map<number, Map<string, number>>();
  for (const row of input.buckets) {
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
  const totals = perSite(input.totals);
  const prevTotals = perSite(input.compare ?? []);

  const ids = input.sites?.map((site) => site.id) ?? [...totals.keys()];
  const axisOf = new Map(input.axes.map((axis) => [axis.siteId, axis.keys]));
  const stats: SiteStat[] = [];
  for (const site of ids) {
    const values = bySite.get(site);
    const buckets = axisOf.get(site) ?? [];
    const total = totals.get(site) ?? 0;
    const prev = prevTotals.get(site) ?? 0;
    stats.push({
      site,
      buckets,
      total,
      spark: buckets.map((bucket) => values?.get(bucket) ?? 0),
      // Both sides required: a brand-new (or just-quiet) period reads as "—",
      // not a red −100% — same reasoning the old same-weekday delta used.
      deltaPct: total > 0 && prev > 0 ? Math.round(((total - prev) / prev) * 100) : undefined,
      silent: total === 0 && (values === undefined || values.size === 0),
    });
  }
  return sorted(stats, input.sort ?? 'traffic', input.sites);
}

/** One row per site in an unbucketed `× site` result. */
function perSite(rows: readonly ResultRow[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const row of rows) {
    if (typeof row.site === 'number') totals.set(row.site, num(row.visitors));
  }
  return totals;
}

function sorted(
  stats: SiteStat[],
  sort: SiteSort,
  sites: readonly SiteInfo[] | undefined,
): SiteStat[] {
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
