import { describe, expect, it } from 'vitest';
import { elapsedThrough, hourBucketKey, localClock, startOfLocalHour } from './time.ts';

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

/**
 * The quantum the rolling range preset snaps to. A UTC-hour floor would pass
 * every test a whole-hour-offset zone can write and still put three quarters of
 * the oldest bucket outside the window in Kathmandu — so the zone's own offset
 * is what decides, and the cases below are the ones that tell the two apart.
 */
describe('startOfLocalHour', () => {
  const HOUR = 3_600_000;

  it('floors to the local hour boundary, which is a UTC one only in whole-hour zones', () => {
    expect(startOfLocalHour('America/New_York', Date.UTC(2026, 6, 27, 14, 37, 12))).toBe(
      Date.UTC(2026, 6, 27, 14),
    );
    // Kathmandu is +05:45: local hours begin at :15 past each UTC hour.
    expect(startOfLocalHour('Asia/Kathmandu', Date.UTC(2026, 6, 27, 14, 37))).toBe(
      Date.UTC(2026, 6, 27, 14, 15),
    );
    expect(startOfLocalHour('Asia/Kathmandu', Date.UTC(2026, 6, 27, 14, 5))).toBe(
      Date.UTC(2026, 6, 27, 13, 15),
    );
    // Kolkata is +05:30.
    expect(startOfLocalHour('Asia/Kolkata', Date.UTC(2026, 6, 27, 14, 5))).toBe(
      Date.UTC(2026, 6, 27, 13, 30),
    );
  });

  it('is idempotent, and one hour back is one bucket back', () => {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Kathmandu', 'Australia/Lord_Howe']) {
      const start = startOfLocalHour(zone, Date.UTC(2026, 6, 27, 14, 37));
      expect(startOfLocalHour(zone, start)).toBe(start);
      expect(localClock(zone, start).hour).toBe(localClock(zone, start + HOUR - 1).hour);
    }
  });

  it('gives each pass through a doubled fall-back hour its own start', () => {
    // 2026-11-01: 01:59 EDT becomes 01:00 EST — both wear the key '01:00'.
    const first = startOfLocalHour('America/New_York', Date.UTC(2026, 10, 1, 5, 30));
    const second = startOfLocalHour('America/New_York', Date.UTC(2026, 10, 1, 6, 30));
    expect(first).toBe(Date.UTC(2026, 10, 1, 5));
    expect(second).toBe(Date.UTC(2026, 10, 1, 6));
    expect(hourBucketKey(localClock('America/New_York', first))).toBe('2026-11-01 01:00');
    expect(hourBucketKey(localClock('America/New_York', second))).toBe('2026-11-01 01:00');
  });

  it('lands on the hour the clock jumped to across a spring-forward', () => {
    // 2026-03-08: 01:59 EST becomes 03:00 EDT; hour 02 never happens.
    const at = Date.UTC(2026, 2, 8, 7, 30); // 03:30 EDT
    expect(startOfLocalHour('America/New_York', at)).toBe(Date.UTC(2026, 2, 8, 7));
    expect(startOfLocalHour('America/New_York', at) - HOUR).toBe(Date.UTC(2026, 2, 8, 6));
    expect(localClock('America/New_York', Date.UTC(2026, 2, 8, 6)).hour).toBe(1);
  });

  it('falls back to UTC for an invalid timezone, like the rest of this module', () => {
    expect(startOfLocalHour('Not/A_Zone', Date.UTC(2026, 6, 27, 14, 37))).toBe(
      Date.UTC(2026, 6, 27, 14),
    );
  });
});
