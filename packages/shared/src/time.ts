import type { Bucket } from './index.ts';

/**
 * The one place a clock becomes a bucket boundary.
 *
 * Everything else about a query's time window is resolved server-side and
 * *stated* in the response (docs/04 § 3: `meta.windows`, `result.axis`) — the
 * browser derives no windows and enumerates no buckets. What a browser still
 * legitimately owns is the READER's clock: a dashboard left open must let its
 * `today` axis grow as the hour turns, which the last fetch cannot know. Both
 * sides call this, so "which bucket has begun" has exactly one answer.
 *
 * The keys produced here are the compiler's bucket keys (query/compiler.ts
 * `BUCKETS`) built from `local_date`/`local_hour`, which ingest computed with
 * the same formatter shape — en-CA, `h23`, and a bad timezone degrading to UTC
 * rather than throwing.
 */

const clockFormatters = new Map<string, Intl.DateTimeFormat>();
const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Cached per zone: `Intl.DateTimeFormat` construction dominates the call. A zone
 * the runtime does not know degrades to UTC rather than throwing — ingest must
 * not fail on a misconfigured site.
 */
function cachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timezone: string,
  make: (timeZone: string) => Intl.DateTimeFormat,
): Intl.DateTimeFormat {
  let formatter = cache.get(timezone);
  if (formatter === undefined) {
    try {
      formatter = make(timezone);
    } catch {
      formatter = make('UTC');
    }
    cache.set(timezone, formatter);
  }
  return formatter;
}

function makeFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
}

/** The clock formatter plus minutes — only the offset reader needs them. */
function makeWallFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  return cachedFormatter(clockFormatters, timezone, makeFormatter);
}

/** A site-local wall-clock reading: the two columns ingest stores per hit. */
export interface LocalClock {
  /** `YYYY-MM-DD` in the site's timezone — the `local_date` column. */
  date: string;
  /** 0–23 in the site's timezone — the `local_hour` column. */
  hour: number;
}

export function localClock(timezone: string, at: number): LocalClock {
  let year = '';
  let month = '';
  let day = '';
  let hour = 0;
  for (const part of formatterFor(timezone).formatToParts(new Date(at))) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
    else if (part.type === 'hour') hour = Number(part.value);
  }
  return { date: `${year}-${month}-${day}`, hour };
}

/** `YYYY-MM-DD HH:00` — the compiler's `hour` bucket key, verbatim. */
export function hourBucketKey(clock: LocalClock): string {
  return `${clock.date} ${String(clock.hour).padStart(2, '0')}:00`;
}

/**
 * The lexicographic ceiling of the bucket keys that have BEGUN at `at`, in one
 * site's timezone.
 *
 * Hour keys carry their hour, so they need it. Day, week and month keys all sort
 * at or below the local date they fall inside — the day itself, the week's
 * Monday, `2026-07` against `2026-07-29` — so for those the local date IS the
 * ceiling, which is why nothing here needs week or month arithmetic.
 *
 * An axis padded past this point invents zeros: the `today` sparkline that
 * flatlines at midnight and the −100 % trend under it (docs/05 § Numbers).
 */
export function elapsedThrough(bucket: Bucket, timezone: string, at: number): string {
  const clock = localClock(timezone, at);
  return bucket === 'hour' ? hourBucketKey(clock) : clock.date;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * The instant the local hour containing `at` began.
 *
 * The quantum a rolling window snaps to (query/ranges.ts): a window whose edge
 * followed the clock would change on every request and revalidate nothing, so
 * "the last 24 hours" means the last 24 hour BUCKETS — stable within an hour,
 * rolling as the hour turns, exactly as `today` already is within a day.
 *
 * Read from the zone's offset rather than by flooring UTC, because a local hour
 * does not begin on a UTC hour in the quarter- and half-hour zones (Kathmandu,
 * Kolkata, Lord Howe) — there the naive answer puts the window's oldest bucket
 * three quarters outside it. Across a fall-back the two passes through the
 * doubled hour each get their own start, which is what real time did even though
 * both wear one bucket key.
 */
export function startOfLocalHour(timezone: string, at: number): number {
  const wall = at + zoneOffsetMs(timezone, at);
  return at - (((wall % HOUR_MS) + HOUR_MS) % HOUR_MS);
}

/**
 * The zone's UTC offset at `at`. Read as the difference between the wall clock
 * and the instant rather than parsed out of a formatted offset string, so no
 * ICU spelling can change the arithmetic; every IANA offset is a whole number
 * of minutes, which is what makes the truncation exact.
 */
function zoneOffsetMs(timezone: string, at: number): number {
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  const formatter = cachedFormatter(wallFormatters, timezone, makeWallFormatter);
  for (const part of formatter.formatToParts(new Date(at))) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return Date.UTC(year, month - 1, day, hour, minute) - Math.floor(at / MINUTE_MS) * MINUTE_MS;
}
