import type { Metric, SiteWindow, Unit } from '@featherstat/shared';
import { windowSpan } from './axis.ts';

/** Display names for the metric vocabulary — exhaustive, so a new metric cannot ship unlabeled. */
export const METRIC_LABELS: Record<Metric, string> = {
  visitors: 'Visitors',
  visits: 'Visits',
  pageviews: 'Pageviews',
  events: 'Events',
  outlinks: 'Outbound links',
  downloads: 'Downloads',
  engaged_sessions: 'measured visits',
  engaged_ms: 'Engaged time',
  avg_engagement: 'Avg engagement',
  bounce_rate: 'Bounce rate',
  views_per_visit: 'Views / visit',
  event_value_sum: 'Event value',
};

/**
 * What a `distinct` measure is worth saying out loud (docs/03 § Visitor
 * identity, docs/05 § Numbers). The visitor hash is salted with a salt that
 * rotates at 00:00 UTC, so a count is exact within a day and an approximation
 * over anything longer — and there is no total across buckets at all, which is
 * why `measureTotal` refuses one. Every distinct-count figure wears this,
 * derived from the measure rather than pinned to `visitors` by name.
 */
export const DISTINCT_NOTE =
  'Exact within a day, approximate over a longer range: visitor ids rotate at 00:00 UTC.';

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

/**
 * A value written as its measure's unit says (docs/04 § 3).
 *
 * The unit is the server's, so a figure and every reduction of it — a tile and
 * its own sparkline — are written by the same rule. A `rate` is always a
 * fraction in 0–1 and is multiplied by 100 exactly HERE and nowhere else; the
 * bounce tile and its spark once disagreed about that, one on 0–1 and the other
 * on 0–100, because each did its own scaling.
 */
export function formatMeasure(unit: Unit, value: number): string {
  switch (unit) {
    case 'count':
      return compactNumber(value);
    case 'ms':
      return formatDuration(value);
    case 'rate':
      return `${Math.round(value * 100)}%`;
    case 'value':
      // A plain real (views per visit, an event-value sum): keep a decimal while
      // it carries information, compact it once it stops.
      return Math.abs(value) >= 1_000 ? compactNumber(value) : trimZero(value.toFixed(1));
  }
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
 * The range a response covers, as the filter row states it (`Jul 1 – Jul 29`).
 *
 * Read straight off the server's resolved windows, so a view, a share page and
 * an editor preview cannot disagree about what is on screen — and so the label
 * can never describe a different window from the data beside it, which is what
 * a client-side preset resolver did after local midnight. Across a `site: "all"`
 * batch the span covers every site's window, since around a midnight they differ.
 */
export function windowLabel(windows: readonly SiteWindow[] | undefined): string | undefined {
  const span = windowSpan(windows);
  if (span === undefined) return undefined;
  return span.from === span.to
    ? bucketLabel(span.from)
    : `${bucketLabel(span.from)} – ${bucketLabel(span.to)}`;
}

/**
 * A duration worth printing. Under a second there is nothing to say and `0s`
 * reads as a bug, so the segment is dropped instead — the same rule the visitor
 * tally has always applied to its own figure.
 */
export function displayDuration(ms: number | undefined): string | undefined {
  return ms === undefined || ms < 1_000 ? undefined : formatDuration(ms);
}
