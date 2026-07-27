import { isQueryError, type Metric, type QueryResponse } from '@analytics/shared';

/** Display names for the metric vocabulary — exhaustive, so a new metric cannot ship unlabeled. */
export const METRIC_LABELS: Record<Metric, string> = {
  visitors: 'Visitors',
  visits: 'Visits',
  pageviews: 'Pageviews',
  events: 'Events',
  engaged_ms: 'Engaged time',
  bounce_rate: 'Bounce rate',
  views_per_visit: 'Views / visit',
  event_value_sum: 'Event value',
};

export function exactNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** docs/05 § Numbers: compact display (`12.9K`, `4.2M`); exact values live in tooltips. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`;
  if (abs >= 10_000) return `${trimZero((n / 1_000).toFixed(1))}K`;
  return exactNumber(Math.round(n));
}

function trimZero(fixed: string): string {
  return fixed.replace(/\.0$/, '');
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Bucket values are site-local date strings computed at ingest (docs/03), so they
// are formatted as-is — parsing them in the browser's timezone would shift days.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^\d{4}-\d{2}-\d{2} (\d{2}):00$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Axis label for a bucket value: `Jul 5`, `14:00`, `Jul 2026`. */
export function bucketLabel(bucket: string): string {
  const hour = HOUR_RE.exec(bucket);
  if (hour !== null) return `${hour[1] ?? ''}:00`;
  if (DATE_RE.test(bucket)) return utcFormat(bucket, { month: 'short', day: 'numeric' });
  if (MONTH_RE.test(bucket)) return utcFormat(`${bucket}-01`, { month: 'short', year: 'numeric' });
  return bucket;
}

/** Tooltip title for a bucket: fuller than the axis label (`Sun, Jul 27`). */
export function bucketTitle(bucket: string): string {
  const hour = HOUR_RE.exec(bucket);
  if (hour !== null) {
    return `${utcFormat(bucket.slice(0, 10), { month: 'short', day: 'numeric' })}, ${hour[1] ?? ''}:00`;
  }
  if (DATE_RE.test(bucket)) {
    return utcFormat(bucket, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return bucketLabel(bucket);
}

function utcFormat(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}

/**
 * The site-local date window a batch's bucketed results span — what the filter
 * row shows as "Jun 28 – Jul 27". Scanned from the data because the response
 * meta does not (yet) carry the server-resolved window: this is the data
 * extent, so a range whose first or last days are empty reads slightly narrow.
 * When `meta.range` lands (docs/04), it replaces this.
 */
export function bucketedWindow(
  response: QueryResponse | undefined,
): { from: string; to: string } | undefined {
  if (response === undefined) return undefined;
  let from: string | undefined;
  let to: string | undefined;
  for (const result of Object.values(response.results)) {
    if (isQueryError(result)) continue;
    for (const row of result.rows) {
      const bucket = row.bucket;
      if (typeof bucket !== 'string') continue;
      const date = bucket.slice(0, 10); // hour buckets carry their date up front
      if (!DATE_RE.test(date)) continue;
      if (from === undefined || date < from) from = date;
      if (to === undefined || date > to) to = date;
    }
  }
  return from === undefined || to === undefined ? undefined : { from, to };
}
