import type { ResultRow } from '@featherstat/shared';
import { displayPath } from './bar-rows.ts';
import { addDaysIso, num } from './series.ts';

/**
 * R20: each all-sites card shows its site's top pages with a per-page trend.
 * Shaped from one `pageviews × path × day` result per site (the queries ride
 * the same all-sites batch — CLAUDE.md invariant 1): rank by the trend
 * window's total, sparkline over those days, delta = the window's back half
 * vs its front half — "how is this article doing lately", not vs last year.
 */

export const PAGE_TREND_DAYS = 14;
export const TOP_PAGES = 3;

export interface PageTrend {
  path: string;
  total: number;
  /** Daily pageviews over the trend window, zero-filled, oldest first. */
  spark: number[];
  /** Signed integer percent, recent half vs previous half; undefined without a baseline. */
  deltaPct: number | undefined;
}

/** `today` is the newest bucket the batch reported — the card grid's shared clock. */
export function topPages(rows: readonly ResultRow[], today: string): PageTrend[] {
  const byPath = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const path = row.path;
    const bucket = row.bucket;
    if (typeof path !== 'string' || typeof bucket !== 'string') continue;
    const display = displayPath(path);
    let days = byPath.get(display);
    if (days === undefined) {
      days = new Map();
      byPath.set(display, days);
    }
    days.set(bucket, (days.get(bucket) ?? 0) + num(row.pageviews));
  }

  const trends: PageTrend[] = [];
  for (const [path, days] of byPath) {
    const spark: number[] = [];
    for (let back = PAGE_TREND_DAYS - 1; back >= 0; back--) {
      spark.push(days.get(addDaysIso(today, -back)) ?? 0);
    }
    const half = PAGE_TREND_DAYS / 2;
    const recent = sum(spark.slice(half));
    const previous = sum(spark.slice(0, half));
    const total = recent + previous;
    if (total === 0) continue;
    trends.push({
      path,
      total,
      spark,
      deltaPct: previous > 0 ? Math.round(((recent - previous) / previous) * 100) : undefined,
    });
  }
  trends.sort((a, b) => b.total - a.total || (a.path < b.path ? -1 : 1));
  return trends.slice(0, TOP_PAGES);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
