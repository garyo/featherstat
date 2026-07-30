import {
  type Bucket,
  DAY_MS,
  elapsedThrough,
  hourBucketKey,
  localClock,
  MAX_AXIS_KEYS,
  type Range,
  type SiteAxis,
  type SiteWindow,
  startOfLocalHour,
} from '@featherstat/shared';

/**
 * Range presets resolve to inclusive `local_date` bounds in one site's timezone
 * (docs/03 § Timezones: the tz math happened at ingest, so date windows are plain
 * indexed string comparisons). `site: "all"` resolves a window per site.
 *
 * `24h` is the exception and the reason `DateWindow` carries instants at all: a
 * rolling day starts and ends INSIDE a local date, so dates alone cannot express
 * it (docs/04 § 3). It rolls by the hour, never by the millisecond — a moving
 * edge would mint a new ETag on every request and revalidate nothing.
 *
 * This module also enumerates a window's bucket keys, because the server is the
 * only party that knows the timezone the range resolved in AND the granularity
 * the query ran at. That answer travels in the response (docs/04 § 3), so no
 * client re-derives it.
 */
export interface DateWindow {
  from: string;
  to: string;
  /** See `SiteWindow`: a half-open UTC-ms refinement, only for a rolling window. */
  fromTs?: number;
  toTs?: number;
}

/** Days a preset covers, counting today. */
const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

const HOUR_MS = 3_600_000;

/** Hour buckets `24h` covers, counting the one in progress. */
const ROLLING_HOURS = 24;

/** The tz database's widest offsets are ±14 h, so a local date starts within this of UTC midnight. */
const OFFSET_SLACK_MS = 15 * HOUR_MS;

/** Upper bound on hour keys per local date — a day is 23–25 hours across a DST edge. */
const MAX_HOURS_PER_DAY = 25;

export function resolveWindow(range: Range, timezone: string, now: number): DateWindow {
  if ('from' in range) return { from: range.from, to: range.to };
  if (range.preset === '24h') {
    // The 24 hour buckets ending with the one in progress. Its newest bucket is
    // partial exactly as `today`'s is — `clip` says so — but its OLDEST edge
    // moves too, which is the whole point: the preceding 24 hours is the same
    // shape of window, so a comparison against it is like-for-like without any
    // clipping. `today` at 09:00 compares 9 hours against a full 24 by design.
    const toTs = startOfLocalHour(timezone, now) + HOUR_MS;
    return tsWindow(timezone, toTs - ROLLING_HOURS * HOUR_MS, toTs);
  }
  const today = localClock(timezone, now).date;
  if (range.preset === 'today') return { from: today, to: today };
  if (range.preset === 'mtd') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: addDays(today, 1 - PRESET_DAYS[range.preset]), to: today };
}

/**
 * `previous` = the same-length window immediately before; `year` = the same
 * window one year back.
 *
 * A rolling window shifts by its own exact duration, so the previous 24 hours
 * line up hour for hour with the current 24 — including across a DST edge, where
 * shifting whole local dates instead would land an hour out.
 */
export function compareWindow(window: SiteWindow, mode: 'previous' | 'year'): DateWindow {
  const { fromTs, toTs } = window;
  if (fromTs !== undefined && toTs !== undefined) {
    const shift =
      mode === 'year' ? parseIso(window.to) - parseIso(addYears(window.to, -1)) : toTs - fromTs;
    return tsWindow(window.timezone, fromTs - shift, toTs - shift);
  }
  if (mode === 'year') return { from: addYears(window.from, -1), to: addYears(window.to, -1) };
  const days = daysBetween(window.from, window.to) + 1;
  return { from: addDays(window.from, -days), to: addDays(window.from, -1) };
}

/** A half-open UTC-ms span, wearing the inclusive local dates it touches. */
function tsWindow(timezone: string, fromTs: number, toTs: number): DateWindow {
  return {
    from: localClock(timezone, fromTs).date,
    to: localClock(timezone, toTs - 1).date,
    fromTs,
    toTs,
  };
}

/**
 * Every bucket key inside one site's window, oldest first, plus where elapsed
 * time stops (`clip`). Keys are byte-identical to the compiler's bucket
 * expressions — this is the axis clients zip sparse rows against, so a key that
 * disagreed would read as a gap.
 *
 * Undefined when the window would enumerate more than `MAX_AXIS_KEYS`: the axis
 * rides in the body of a public share link, and an explicit range at `hour`
 * granularity is otherwise unbounded.
 */
export function bucketAxis(window: SiteWindow, bucket: Bucket, now: number): SiteAxis | undefined {
  const days = daysBetween(window.from, window.to) + 1;
  if (days < 1) return undefined;
  if (bucket === 'hour' && days * MAX_HOURS_PER_DAY > MAX_AXIS_KEYS) return undefined;
  if (days > MAX_AXIS_KEYS) return undefined;

  const keys = bucket === 'hour' ? hourKeys(window) : dateDerivedKeys(window, bucket);
  const ceiling = elapsedThrough(bucket, window.timezone, now);
  const begun = keys.filter((key) => key <= ceiling);
  const clip = begun[begun.length - 1];
  return { siteId: window.siteId, keys, ...(clip === undefined ? {} : { clip }) };
}

/**
 * Local hours are read from the zone rather than counted, so a spring-forward
 * day yields 23 keys with no `02:00` (an hour that never happened, which SQL can
 * never return a row for) and a fall-back day yields 24 keys with one `01:00`
 * (both passes through it share the `local_hour` bucket, so they share the key).
 *
 * A rolling window walks its own instants instead of expanding whole dates: it
 * starts mid-day and spans two of them, so `[from, to]` names the dates it
 * touches and would enumerate roughly twice the hours it holds. Counting to 24
 * would be wrong for the same reason it is wrong for a day — 24 hours of real
 * time is 24 keys, except across a fall-back, where one key covers two of them.
 */
function hourKeys(window: SiteWindow): string[] {
  const keys: string[] = [];
  const last = (): string | undefined => keys[keys.length - 1];
  const until = window.toTs ?? parseIso(window.to) + DAY_MS + OFFSET_SLACK_MS;
  for (
    let at = window.fromTs ?? parseIso(window.from) - OFFSET_SLACK_MS;
    at < until;
    at += HOUR_MS
  ) {
    const clock = localClock(window.timezone, at);
    if (clock.date < window.from) continue;
    if (clock.date > window.to) break;
    const key = hourBucketKey(clock);
    if (key !== last()) keys.push(key);
  }
  return keys;
}

/** `day`, `week` and `month` keys are functions of the local date alone — no clock, no zone. */
function dateDerivedKeys(window: SiteWindow, bucket: Bucket): string[] {
  const keys: string[] = [];
  const last = (): string | undefined => keys[keys.length - 1];
  for (let date = window.from; date <= window.to; date = addDays(date, 1)) {
    const key = bucket === 'day' ? date : bucket === 'week' ? mondayOf(date) : date.slice(0, 7);
    if (key !== last()) keys.push(key);
  }
  return keys;
}

/**
 * The Monday starting this date's week, matching the compiler's
 * `date(d, '+1 day', 'weekday 1', '-7 days')`: Sunday belongs to the week that
 * started the previous Monday.
 */
function mondayOf(date: string): string {
  const weekday = new Date(parseIso(date)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

function addDays(date: string, days: number): string {
  return isoDate(parseIso(date) + days * DAY_MS);
}

function addYears(date: string, years: number): string {
  const shifted = new Date(parseIso(date));
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return isoDate(shifted.getTime());
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseIso(to) - parseIso(from)) / DAY_MS);
}

function parseIso(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
