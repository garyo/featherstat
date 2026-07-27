import { describe, expect, it } from 'vitest';
import { compareWindow, resolveWindow } from './ranges.ts';

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
