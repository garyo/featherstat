import { type Measures, measureTotal, type ResultRow } from '@featherstat/shared';
import { num } from './series.ts';

/**
 * R20: each all-sites card shows its site's top pages with a per-page trend.
 * Shaped from one `pageviews × path × day` result per site (the queries ride
 * the same all-sites batch — CLAUDE.md invariant 1): rank by the selected
 * range's total, sparkline over its buckets. No delta: the card's headline
 * delta is visitors vs the previous period, and a second percentage beside it
 * meaning something else read as a contradiction.
 *
 * Ranking means totalling a metric over buckets, which is only legal for some of
 * them, so the total goes through the result's own `measures` header rather than
 * a bare `+`. Today the query names `pageviews` and the sum is additive; point
 * this widget at `visitors` and it renders no trend at all instead of quietly
 * counting a returning reader once per day (docs/04 § 3).
 */

export const TOP_PAGES = 3;

export interface PageTrend {
  path: string;
  total: number;
  /** Pageviews per bucket of the card's window, zero-filled, oldest first. */
  spark: number[];
}

const METRIC = 'pageviews';

/** `buckets` is the site's enumerated window — the same clock its card spark uses. */
export function topPages(
  rows: readonly ResultRow[],
  buckets: readonly string[],
  measures: Measures | undefined,
): PageTrend[] {
  const measure = measures?.[METRIC];
  if (measure === undefined) return [];

  const byPath = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const path = row.path;
    const bucket = row.bucket;
    if (typeof path !== 'string' || typeof bucket !== 'string') continue;
    let days = byPath.get(path);
    if (days === undefined) {
      days = new Map();
      byPath.set(path, days);
    }
    days.set(bucket, (days.get(bucket) ?? 0) + num(row[METRIC]));
  }

  const trends: PageTrend[] = [];
  for (const [path, days] of byPath) {
    const spark = buckets.map((bucket) => days.get(bucket) ?? 0);
    const total = measureTotal(
      METRIC,
      measure,
      spark.map((value) => ({ [METRIC]: value })),
    );
    // A measure with no total across buckets cannot be ranked at all; the card
    // shows no page list rather than a ranking nothing supports.
    if (total === undefined) return [];
    if (total === 0) continue;
    trends.push({ path, total, spark });
  }
  trends.sort((a, b) => b.total - a.total || (a.path < b.path ? -1 : 1));
  return trends.slice(0, TOP_PAGES);
}
