import type { ResultRow } from '@featherstat/shared';

/** One bucket of a time series; absent metric values are 0. */
export interface SeriesPoint {
  bucket: string;
  values: Record<string, number>;
}

/** Categorical slots in fixed order, assigned by position, never cycled. */
export const SERIES_COLORS = ['var(--s1)', 'var(--s2)'];

/** Result cells are `string | number | null`; charts need a number. */
export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Sparse rows + the server's axis → a dense, time-ordered series.
 *
 * SQL GROUP BY skips empty buckets, which would silently distort a line chart,
 * so every key of the axis gets a point. The axis is what the server enumerated
 * for this result, trimmed to the reader's clock (`widgets/axis.ts`) — this
 * function does no time math of its own, which is why day, hour, week and month
 * all work here and why DST has one place to be correct instead of four.
 *
 * A row whose bucket is off the axis is still drawn: an axis is the frame the
 * server could enumerate, never a licence to drop an answer it returned.
 */
export function seriesOf(
  rows: readonly ResultRow[],
  metrics: readonly string[],
  axis: readonly string[],
): SeriesPoint[] {
  const byBucket = new Map<string, ResultRow>();
  for (const row of rows) {
    if (typeof row.bucket === 'string') byBucket.set(row.bucket, row);
  }
  const keys = [...new Set([...axis, ...byBucket.keys()])].sort();
  return keys.map((bucket) => {
    const row = byBucket.get(bucket);
    const values: Record<string, number> = {};
    for (const metric of metrics) values[metric] = row === undefined ? 0 : num(row[metric]);
    return { bucket, values };
  });
}

/** Index ranges `[start, end)` splitting n points into at most `groups` contiguous slices. */
export function sliceRanges(n: number, groups: number): Array<[number, number]> {
  const count = Math.min(groups, n);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    ranges.push([Math.floor((i * n) / count), Math.floor(((i + 1) * n) / count)]);
  }
  return ranges;
}
