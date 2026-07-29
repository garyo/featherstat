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

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached per zone: `Intl.DateTimeFormat` construction dominates the call. */
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    try {
      formatter = makeFormatter(timezone);
    } catch {
      formatter = makeFormatter('UTC');
    }
    formatters.set(timezone, formatter);
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
