import { describe, expect, it } from 'vitest';
import { elapsedThrough, hourBucketKey, localClock } from './time.ts';

/**
 * The site-local clock both sides share (time.ts). Ingest writes
 * `local_date`/`local_hour` with it, the compiler builds bucket keys from those
 * columns, and the browser decides which bucket has begun — so a disagreement
 * here is a disagreement between stored rows and rendered axes.
 */

describe('localClock', () => {
  it('computes local date and hour in the site timezone', () => {
    expect(localClock('America/New_York', Date.UTC(2026, 0, 15, 14, 30))).toEqual({
      date: '2026-01-15',
      hour: 9, // EST, UTC-5
    });
    expect(localClock('America/New_York', Date.UTC(2026, 6, 15, 14, 30))).toEqual({
      date: '2026-07-15',
      hour: 10, // EDT, UTC-4
    });
  });

  it('handles the spring-forward DST boundary (2026-03-08, 02:00 EST skipped)', () => {
    expect(localClock('America/New_York', Date.UTC(2026, 2, 8, 6, 59))).toEqual({
      date: '2026-03-08',
      hour: 1,
    });
    expect(localClock('America/New_York', Date.UTC(2026, 2, 8, 7, 1))).toEqual({
      date: '2026-03-08',
      hour: 3,
    });
  });

  it('handles the fall-back DST boundary (2026-11-01, 01:00 repeats)', () => {
    expect(localClock('America/New_York', Date.UTC(2026, 10, 1, 5, 30)).hour).toBe(1); // EDT
    expect(localClock('America/New_York', Date.UTC(2026, 10, 1, 6, 30)).hour).toBe(1); // EST
    expect(localClock('America/New_York', Date.UTC(2026, 10, 1, 7, 30)).hour).toBe(2);
  });

  it('rolls the local date at local midnight, not UTC midnight', () => {
    expect(localClock('America/New_York', Date.UTC(2026, 6, 28, 3, 30)).date).toBe('2026-07-27');
    expect(localClock('America/New_York', Date.UTC(2026, 6, 28, 4, 30)).date).toBe('2026-07-28');
  });

  it('falls back to UTC for an invalid timezone instead of breaking ingest', () => {
    expect(localClock('Not/A_Zone', Date.UTC(2026, 6, 27, 14))).toEqual({
      date: '2026-07-27',
      hour: 14,
    });
  });
});

describe('bucket ceilings', () => {
  it('keys an hour bucket with a zero-padded hour', () => {
    expect(hourBucketKey({ date: '2026-07-27', hour: 9 })).toBe('2026-07-27 09:00');
    expect(hourBucketKey({ date: '2026-07-27', hour: 23 })).toBe('2026-07-27 23:00');
  });

  it('ceils to the hour in progress for hour buckets and to the local date otherwise', () => {
    const at = Date.UTC(2026, 6, 27, 14, 59); // 10:59 EDT
    expect(elapsedThrough('hour', 'America/New_York', at)).toBe('2026-07-27 10:00');
    for (const bucket of ['day', 'week', 'month'] as const) {
      expect(elapsedThrough(bucket, 'America/New_York', at)).toBe('2026-07-27');
    }
  });
});
