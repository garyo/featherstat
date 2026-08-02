import type { SiteWindow } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { bucketAxis, compareWindow, type DateWindow, resolveWindow } from './ranges.ts';

/** 2026-07-28 02:00 UTC — still 2026-07-27 22:00 in New York. */
const NOW = Date.UTC(2026, 6, 28, 2);

const HOUR = 3_600_000;

/** A resolved window as `compareWindow` takes it: dates, plus a rolling window's instants. */
const at = (timezone: string, window: DateWindow): SiteWindow => ({
  siteId: 1,
  timezone,
  ...window,
});

describe('resolveWindow', () => {
  it("resolves 'today' in the site's timezone, not UTC", () => {
    expect(resolveWindow({ preset: 'today' }, 'America/New_York', NOW)).toEqual({
      from: '2026-07-27',
      to: '2026-07-27',
    });
    expect(resolveWindow({ preset: 'today' }, 'UTC', NOW)).toEqual({
      from: '2026-07-28',
      to: '2026-07-28',
    });
  });

  it('resolves the rolling presets to windows ending today', () => {
    expect(resolveWindow({ preset: '7d' }, 'America/New_York', NOW)).toEqual({
      from: '2026-07-21',
      to: '2026-07-27',
    });
    expect(resolveWindow({ preset: '30d' }, 'UTC', NOW)).toEqual({
      from: '2026-06-29',
      to: '2026-07-28',
    });
    expect(resolveWindow({ preset: '90d' }, 'UTC', NOW)).toEqual({
      from: '2026-04-30',
      to: '2026-07-28',
    });
  });

  it("resolves 'mtd' from the first of the local month", () => {
    expect(resolveWindow({ preset: 'mtd' }, 'America/New_York', NOW)).toEqual({
      from: '2026-07-01',
      to: '2026-07-27',
    });
    expect(resolveWindow({ preset: 'mtd' }, 'UTC', Date.UTC(2026, 0, 1, 12))).toEqual({
      from: '2026-01-01',
      to: '2026-01-01',
    });
  });

  it('passes explicit from/to through untouched', () => {
    expect(resolveWindow({ from: '2026-06-01', to: '2026-06-30' }, 'Asia/Tokyo', NOW)).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });
});

/**
 * The one ROLLING preset (docs/04 § 3). It is quantized to the hour on purpose:
 * an edge that followed the clock would move on every request, changing the
 * resolved window the ETag hashes and revalidating nothing.
 */
describe("resolveWindow '24h'", () => {
  const resolve = (timezone: string, now: number): DateWindow =>
    resolveWindow({ preset: '24h' }, timezone, now);

  it('is the 24 hour buckets ending with the one in progress', () => {
    // 2026-07-27 22:37 in New York → the window runs from 23:00 the day before.
    const window = resolve('America/New_York', NOW + 37 * 60_000);
    expect(window).toEqual({
      from: '2026-07-26',
      to: '2026-07-27',
      fromTs: Date.UTC(2026, 6, 27, 3), // 2026-07-26 23:00 EDT
      toTs: Date.UTC(2026, 6, 28, 3), // 2026-07-27 23:00 EDT, exclusive
    });
    expect((window.toTs ?? 0) - (window.fromTs ?? 0)).toBe(24 * HOUR);
  });

  it('is stable within the hour and rolls when the hour turns', () => {
    const start = Date.UTC(2026, 6, 28, 2);
    const sameHour = resolve('UTC', start + 59 * 60_000 + 59_000);
    expect(sameHour).toEqual(resolve('UTC', start));
    const nextHour = resolve('UTC', start + HOUR);
    expect(nextHour.fromTs).toBe((sameHour.fromTs ?? 0) + HOUR);
    expect(nextHour.toTs).toBe((sameHour.toTs ?? 0) + HOUR);
  });

  it('quantizes to the SITE hour, which is not a UTC hour in a 45-minute zone', () => {
    // Kathmandu is +05:45: 07:37 UTC is 13:22 local, whose hour began at 07:15 UTC.
    const window = resolve('Asia/Kathmandu', Date.UTC(2026, 6, 27, 7, 37));
    expect(window.toTs).toBe(Date.UTC(2026, 6, 27, 8, 15));
    expect(window.fromTs).toBe(Date.UTC(2026, 6, 26, 8, 15));
  });

  it('wears the two local dates it spans, so the indexed date bound still covers it', () => {
    const window = resolve('UTC', Date.UTC(2026, 6, 28, 2, 30));
    expect(window).toMatchObject({ from: '2026-07-27', to: '2026-07-28' });
  });
});

describe('compareWindow', () => {
  it("'previous' is the same-length window immediately before", () => {
    expect(compareWindow(at('UTC', { from: '2026-07-27', to: '2026-07-27' }), 'previous')).toEqual({
      from: '2026-07-26',
      to: '2026-07-26',
    });
    expect(compareWindow(at('UTC', { from: '2026-06-01', to: '2026-06-30' }), 'previous')).toEqual({
      from: '2026-05-02',
      to: '2026-05-31',
    });
  });

  it("'previous' crosses month and year boundaries by day arithmetic", () => {
    expect(compareWindow(at('UTC', { from: '2026-01-01', to: '2026-01-07' }), 'previous')).toEqual({
      from: '2025-12-25',
      to: '2025-12-31',
    });
  });

  it("'year' is the same window one year back", () => {
    expect(compareWindow(at('UTC', { from: '2026-06-01', to: '2026-06-30' }), 'year')).toEqual({
      from: '2025-06-01',
      to: '2025-06-30',
    });
  });

  /**
   * The point of the rolling preset: its comparison needs no clipping to be
   * honest, because the preceding 24 hours is the same shape of window. `today`
   * at 09:00 deliberately compares 9 hours against a complete yesterday — that is
   * how a calendar range reads, and why this preset exists beside it.
   */
  it('shifts a rolling window by its own exact duration', () => {
    const current = resolveWindow({ preset: '24h' }, 'America/New_York', NOW);
    const previous = compareWindow(at('America/New_York', current), 'previous');
    expect(previous.toTs).toBe(current.fromTs);
    expect((previous.toTs ?? 0) - (previous.fromTs ?? 0)).toBe(24 * HOUR);
    expect(previous).toMatchObject({ from: '2026-07-25', to: '2026-07-26' });
  });

  it('keeps a rolling window 24 real hours long across a spring-forward', () => {
    // 2026-03-08 12:00 EDT: the previous 24 hours contain the hour that vanished.
    const current = resolveWindow(
      { preset: '24h' },
      'America/New_York',
      Date.parse('2026-03-08T16:30:00Z'),
    );
    const previous = compareWindow(at('America/New_York', current), 'previous');
    expect((current.toTs ?? 0) - (current.fromTs ?? 0)).toBe(24 * HOUR);
    expect((previous.toTs ?? 0) - (previous.fromTs ?? 0)).toBe(24 * HOUR);
    // Shifting whole local dates instead would land an hour out here.
    expect(previous.toTs).toBe(current.fromTs);
  });

  it('uses an explicit {from, to} exactly as given — equal length or not', () => {
    const window = at('UTC', { from: '2026-07-21', to: '2026-07-27' });
    expect(compareWindow(window, { from: '2026-06-01', to: '2026-06-07' })).toEqual({
      from: '2026-06-01',
      to: '2026-06-07',
      fromTs: undefined,
      toTs: undefined,
    });
    // An unequal-length compare window is still used as given: rows align by
    // index from the start, and meta.windows labels the mismatch (docs/04 § 3).
    expect(compareWindow(window, { from: '2026-06-01', to: '2026-06-30' })).toMatchObject({
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });

  it("clears a rolling window's instants under an explicit compare — dates are all it states", () => {
    const current = resolveWindow({ preset: '24h' }, 'America/New_York', NOW);
    const compared = compareWindow(at('America/New_York', current), {
      from: '2026-07-01',
      to: '2026-07-02',
    });
    expect(compared.fromTs).toBeUndefined();
    expect(compared.toTs).toBeUndefined();
    expect(compared).toMatchObject({ from: '2026-07-01', to: '2026-07-02' });
  });
});

/**
 * The axis is the answer clients zip their sparse rows against, so its keys must
 * be byte-identical to the compiler's bucket expressions — and its hour keys must
 * come from the ZONE, not from counting to 24. There were zero DST tests in this
 * repo before P1; the client's contiguous hour enumeration fabricated an hour
 * that cannot exist on spring-forward.
 */
describe('bucketAxis', () => {
  const window = (timezone: string, from: string, to = from): SiteWindow => ({
    siteId: 1,
    timezone,
    from,
    to,
  });

  it('enumerates days across the window and clips at the local today', () => {
    const axis = bucketAxis(window('UTC', '2026-07-27', '2026-07-31'), 'day', NOW);
    expect(axis?.keys).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
    ]);
    // NOW is 2026-07-28 02:00 UTC: the 29th onward has not begun.
    expect(axis?.clip).toBe('2026-07-28');
  });

  it("clips on the SITE's clock, not the server's", () => {
    // Same instant, New York is still on the 27th.
    expect(
      bucketAxis(window('America/New_York', '2026-07-27', '2026-07-31'), 'day', NOW)?.clip,
    ).toBe('2026-07-27');
  });

  it('runs an hour axis to the end of the local day and clips at the hour in progress', () => {
    const axis = bucketAxis(window('UTC', '2026-07-28'), 'hour', NOW);
    expect(axis?.keys).toHaveLength(24);
    expect(axis?.keys.at(-1)).toBe('2026-07-28 23:00');
    expect(axis?.clip).toBe('2026-07-28 02:00');
  });

  it('groups weeks on the compiler’s Monday and months on YYYY-MM', () => {
    const weeks = bucketAxis(window('UTC', '2026-07-05', '2026-07-21'), 'week', NOW);
    // 2026-07-05 is a Sunday: it belongs to the week that started 2026-06-29.
    expect(weeks?.keys).toEqual(['2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20']);
    const months = bucketAxis(window('UTC', '2026-05-30', '2026-07-02'), 'month', NOW);
    expect(months?.keys).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('has no clip when the whole window is still in the future', () => {
    const axis = bucketAxis(window('UTC', '2026-09-01', '2026-09-03'), 'day', NOW);
    expect(axis?.keys).toHaveLength(3);
    expect(axis?.clip).toBeUndefined();
  });

  /**
   * A rolling window starts mid-day and spans two local dates, so the axis walks
   * its own instants: expanding `[from, to]` into whole dates would enumerate 48
   * hour keys for a window that holds 24.
   */
  it('enumerates a rolling window as 24 hour keys crossing local midnight', () => {
    const now = Date.UTC(2026, 6, 28, 2, 30); // 02:30 UTC
    const rolling = at('UTC', resolveWindow({ preset: '24h' }, 'UTC', now));
    const axis = bucketAxis(rolling, 'hour', now);
    expect(axis?.keys).toHaveLength(24);
    expect(axis?.keys[0]).toBe('2026-07-27 03:00');
    expect(axis?.keys[20]).toBe('2026-07-27 23:00');
    expect(axis?.keys[21]).toBe('2026-07-28 00:00');
    expect(axis?.keys.at(-1)).toBe('2026-07-28 02:00');
    // The newest bucket is the one in progress — the same partial edge `today` has.
    expect(axis?.clip).toBe('2026-07-28 02:00');
  });

  it('is withheld rather than unbounded: hours over an explicit long range', () => {
    expect(bucketAxis(window('UTC', '2026-01-01', '2026-12-31'), 'hour', NOW)).toBeUndefined();
    // Days over the same range still fit.
    expect(bucketAxis(window('UTC', '2026-01-01', '2026-12-31'), 'day', NOW)?.keys).toHaveLength(
      365,
    );
  });

  describe('DST', () => {
    /** 2026-03-08: 01:59 EST becomes 03:00 EDT — local hour 2 never happens. */
    it('spring-forward yields 23 hours and never fabricates the hour that was skipped', () => {
      const axis = bucketAxis(window('America/New_York', '2026-03-08'), 'hour', NOW);
      expect(axis?.keys).toHaveLength(23);
      expect(axis?.keys).not.toContain('2026-03-08 02:00');
      expect(axis?.keys.slice(0, 4)).toEqual([
        '2026-03-08 00:00',
        '2026-03-08 01:00',
        '2026-03-08 03:00',
        '2026-03-08 04:00',
      ]);
      expect(axis?.keys.at(-1)).toBe('2026-03-08 23:00');
    });

    /** 2026-11-01: 01:59 EDT becomes 01:00 EST — local hour 1 happens twice. */
    it('fall-back yields 24 keys: the doubled hour shares one bucket, and is not hidden', () => {
      const axis = bucketAxis(window('America/New_York', '2026-11-01'), 'hour', NOW);
      expect(axis?.keys).toHaveLength(24);
      expect(axis?.keys.filter((key) => key === '2026-11-01 01:00')).toHaveLength(1);
      expect(axis?.keys.slice(0, 4)).toEqual([
        '2026-11-01 00:00',
        '2026-11-01 01:00',
        '2026-11-01 02:00',
        '2026-11-01 03:00',
      ]);
      expect(axis?.keys.at(-1)).toBe('2026-11-01 23:00');
    });

    it('clips inside the doubled hour without skipping past it', () => {
      // 05:30 UTC is 01:30 EDT (first pass); 06:30 UTC is 01:30 EST (second).
      const first = bucketAxis(
        window('America/New_York', '2026-11-01'),
        'hour',
        Date.parse('2026-11-01T05:30:00Z'),
      );
      const second = bucketAxis(
        window('America/New_York', '2026-11-01'),
        'hour',
        Date.parse('2026-11-01T06:30:00Z'),
      );
      expect(first?.clip).toBe('2026-11-01 01:00');
      expect(second?.clip).toBe('2026-11-01 01:00');
    });

    it('a spring-forward day resolves to a day bucket like any other', () => {
      const axis = bucketAxis(
        window('America/New_York', '2026-03-07', '2026-03-09'),
        'day',
        Date.parse('2026-03-09T16:00:00Z'),
      );
      expect(axis?.keys).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
      expect(axis?.clip).toBe('2026-03-09');
    });

    it('keeps a rolling window 24 buckets across a spring-forward, with no 02:00', () => {
      const now = Date.parse('2026-03-08T16:30:00Z'); // 12:30 EDT
      const rolling = at(
        'America/New_York',
        resolveWindow({ preset: '24h' }, 'America/New_York', now),
      );
      const axis = bucketAxis(rolling, 'hour', now);
      expect(axis?.keys).toHaveLength(24);
      expect(axis?.keys).not.toContain('2026-03-08 02:00');
      // 24 hours before 13:00 EDT is 12:00 EST — the wall clock moved 25 hours.
      expect(axis?.keys[0]).toBe('2026-03-07 12:00');
      expect(axis?.keys.at(-1)).toBe('2026-03-08 12:00');
      expect(axis?.clip).toBe('2026-03-08 12:00');
    });

    it('yields 23 buckets across a fall-back: 24 real hours, one doubled key', () => {
      const now = Date.parse('2026-11-01T21:30:00Z'); // 16:30 EST
      const rolling = at(
        'America/New_York',
        resolveWindow({ preset: '24h' }, 'America/New_York', now),
      );
      const axis = bucketAxis(rolling, 'hour', now);
      // The 01:00 bucket held two real hours, so 24 hours of time is 23 keys —
      // the same rule the fall-back DAY axis follows, not a lost hour.
      expect(axis?.keys).toHaveLength(23);
      expect(axis?.keys.filter((key) => key === '2026-11-01 01:00')).toHaveLength(1);
      expect(axis?.keys[0]).toBe('2026-10-31 18:00');
      expect(axis?.keys.at(-1)).toBe('2026-11-01 16:00');
      expect(axis?.clip).toBe('2026-11-01 16:00');
    });

    it('handles a half-hour zone and a zone whose DST shift is 30 minutes', () => {
      // Kathmandu is +05:45 with no DST: 24 keys, first at 00:00.
      const nepal = bucketAxis(window('Asia/Kathmandu', '2026-07-28'), 'hour', NOW);
      expect(nepal?.keys).toHaveLength(24);
      expect(nepal?.keys[0]).toBe('2026-07-28 00:00');
      // Lord Howe shifts by 30 minutes on 2026-04-05 (DST ends): still 24 local hours.
      const lordHowe = bucketAxis(window('Australia/Lord_Howe', '2026-04-05'), 'hour', NOW);
      expect(lordHowe?.keys[0]).toBe('2026-04-05 00:00');
      expect(lordHowe?.keys.at(-1)).toBe('2026-04-05 23:00');
    });
  });
});
