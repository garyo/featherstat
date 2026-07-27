import { DAY_MS, type ResultRow } from '@analytics/shared';

/** One bucket of a time series after gap-filling; absent metric values are 0. */
export interface SeriesPoint {
  bucket: string;
  values: Record<string, number>;
}

/** Result cells are `string | number | null`; charts need a number. */
export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^(\d{4}-\d{2}-\d{2}) \d{2}:00$/;
/** Sanity cap on gap-filling — no preset resolves to more buckets than this. */
const MAX_FILL = 1_000;

/**
 * Bucketed rows → a dense, time-ordered series. SQL GROUP BY skips empty
 * buckets, which would silently distort a line chart, so day gaps (and hour
 * gaps within a single day) are zero-filled. Other bucket shapes pass through
 * in sorted order.
 */
export function fillBuckets(rows: readonly ResultRow[], metrics: readonly string[]): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const row of rows) {
    const bucket = row.bucket;
    if (typeof bucket !== 'string') continue;
    const values: Record<string, number> = {};
    for (const metric of metrics) values[metric] = num(row[metric]);
    points.push({ bucket, values });
  }
  points.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || points.length < 2) return points;
  if (points.every((p) => DATE_RE.test(p.bucket))) {
    return fill(points, metrics, dateSequence(first.bucket, last.bucket));
  }
  const hours = points.map((p) => HOUR_RE.exec(p.bucket));
  if (
    hours.every((m): m is RegExpExecArray => m !== null) &&
    new Set(hours.map((m) => m[1])).size === 1
  ) {
    return fill(points, metrics, hourSequence(first.bucket, last.bucket));
  }
  return points;
}

function fill(
  points: readonly SeriesPoint[],
  metrics: readonly string[],
  buckets: readonly string[],
): SeriesPoint[] {
  const present = new Map(points.map((p) => [p.bucket, p]));
  return buckets.map(
    (bucket) =>
      present.get(bucket) ?? {
        bucket,
        values: Object.fromEntries(metrics.map((metric) => [metric, 0])),
      },
  );
}

function dateSequence(from: string, to: string): string[] {
  const out: string[] = [];
  for (let date = from; date <= to && out.length < MAX_FILL; date = addDaysIso(date, 1)) {
    out.push(date);
  }
  return out;
}

function hourSequence(from: string, to: string): string[] {
  const date = from.slice(0, 10);
  const toHour = Number(to.slice(11, 13));
  const out: string[] = [];
  for (let hour = Number(from.slice(11, 13)); hour <= toHour; hour++) {
    out.push(`${date} ${String(hour).padStart(2, '0')}:00`);
  }
  return out;
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
