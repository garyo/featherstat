import type { SiteWindow } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { bucketAxis, compareWindow, resolveWindow } from './ranges.ts';

/** 2026-07-28 02:00 UTC — still 2026-07-27 22:00 in New York. */
const NOW = Date.UTC(2026, 6, 28, 2);

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

describe('compareWindow', () => {
  it("'previous' is the same-length window immediately before", () => {
    expect(compareWindow({ from: '2026-07-27', to: '2026-07-27' }, 'previous')).toEqual({
      from: '2026-07-26',
      to: '2026-07-26',
    });
    expect(compareWindow({ from: '2026-06-01', to: '2026-06-30' }, 'previous')).toEqual({
      from: '2026-05-02',
      to: '2026-05-31',
    });
  });

  it("'previous' crosses month and year boundaries by day arithmetic", () => {
    expect(compareWindow({ from: '2026-01-01', to: '2026-01-07' }, 'previous')).toEqual({
      from: '2025-12-25',
      to: '2025-12-31',
    });
  });

  it("'year' is the same window one year back", () => {
    expect(compareWindow({ from: '2026-06-01', to: '2026-06-30' }, 'year')).toEqual({
      from: '2025-06-01',
      to: '2025-06-30',
    });
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
