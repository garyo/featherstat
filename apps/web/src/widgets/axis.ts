import {
  type Bucket,
  elapsedThrough,
  type QueryResult,
  type SiteAxis,
  type SiteWindow,
} from '@featherstat/shared';

/**
 * The ONE time derivation left in the browser.
 *
 * The server resolved the window, enumerated the buckets, and said where real
 * data stopped (docs/04 § 3: `meta.windows`, `result.axis`). What it cannot know
 * is the reader's clock: a dashboard left open must let a `today` chart grow as
 * the hour turns, and a cached body replayed on a 304 is by then minutes old.
 * So the browser does exactly one thing with time — move the axis's visible end
 * to whichever is newer, the server's `clip` or the reader's own bucket — and it
 * never enumerates, pads, or resolves a preset.
 *
 * `clip` is the floor, not the answer: a reader whose clock runs slow must not
 * hide rows the server actually returned.
 */

/** One site's axis after the reader's clock is applied. */
export interface ViewAxis {
  siteId: number;
  /** Bucket keys to draw, oldest first. */
  keys: string[];
}

export function visibleKeys(
  axis: SiteAxis,
  bucket: Bucket,
  timezone: string,
  now: number,
): string[] {
  const reader = elapsedThrough(bucket, timezone, now);
  const ceiling = axis.clip !== undefined && axis.clip > reader ? axis.clip : reader;
  return axis.keys.filter((key) => key <= ceiling);
}

/**
 * A bucketed result's per-site axes, joined to the windows that carry the
 * timezones. Empty for an unbucketed result, and for one whose axis the server
 * withheld (a 2-D breakdown, or a window past `MAX_AXIS_KEYS`) — `seriesOf`
 * then falls back to the rows' own bucket keys.
 */
export function resultAxes(
  result: QueryResult,
  windows: readonly SiteWindow[],
  now: number,
): ViewAxis[] {
  const bucket = result.bucket;
  if (bucket === undefined || result.axis === undefined) return [];
  const zones = new Map(windows.map((window) => [window.siteId, window.timezone]));
  return result.axis.map((axis) => ({
    siteId: axis.siteId,
    keys: visibleKeys(axis, bucket, zones.get(axis.siteId) ?? 'UTC', now),
  }));
}

/**
 * Every key any site in scope can show, oldest first — the axis of one
 * shared-x chart over a batch that may span timezones.
 */
export function sharedKeys(axes: readonly ViewAxis[]): string[] {
  const keys = new Set<string>();
  for (const axis of axes) for (const key of axis.keys) keys.add(key);
  return [...keys].sort();
}

/** The window label's span, across every site in scope (docs/05 § Time series). */
export function windowSpan(
  windows: readonly SiteWindow[] | undefined,
): { from: string; to: string } | undefined {
  if (windows === undefined || windows.length === 0) return undefined;
  let from = windows[0]?.from ?? '';
  let to = windows[0]?.to ?? '';
  for (const window of windows) {
    if (window.from < from) from = window.from;
    if (window.to > to) to = window.to;
  }
  return { from, to };
}
