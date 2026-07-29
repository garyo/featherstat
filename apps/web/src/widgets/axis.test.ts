import type { QueryResult, SiteAxis, SiteWindow } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { resultAxes, sharedKeys, visibleKeys, windowSpan } from './axis.ts';

/**
 * The browser's one time derivation, so it carries the DST burden the whole
 * client used to spread across four enumerators and never test.
 *
 * The two cases that matter are about the reader's CEILING, since the axis
 * itself is enumerated server-side: on spring-forward the ceiling must never be
 * an hour the zone skipped (an axis trimmed to `02:00` in New York would drop
 * the real `03:00` bucket), and on fall-back the doubled hour shares one bucket
 * key, so the second pass through it must not read as the first and hide the
 * hours after it.
 */

const window = (siteId: number, timezone: string, from: string, to = from): SiteWindow => ({
  siteId,
  timezone,
  from,
  to,
});

const hours = (date: string, from: number, to: number): string[] =>
  Array.from(
    { length: to - from + 1 },
    (_, i) => `${date} ${String(from + i).padStart(2, '0')}:00`,
  );

const days = (...keys: string[]): string[] => keys;

describe('visibleKeys', () => {
  it('stops at the hour in progress, never the end of the calendar day', () => {
    const axis: SiteAxis = {
      siteId: 1,
      keys: hours('2026-07-29', 0, 23),
      clip: '2026-07-29 13:00',
    };
    // 17:40 UTC is 13:40 in New York: the whole day is on the axis, half of it is future.
    const keys = visibleKeys(axis, 'hour', 'America/New_York', Date.parse('2026-07-29T17:40:00Z'));
    expect(keys).toEqual(hours('2026-07-29', 0, 13));
  });

  it('extends as the hour turns, without a refetch', () => {
    const axis: SiteAxis = {
      siteId: 1,
      keys: hours('2026-07-29', 0, 23),
      clip: '2026-07-29 13:00',
    };
    const later = visibleKeys(axis, 'hour', 'UTC', Date.parse('2026-07-29T16:02:00Z'));
    expect(later.at(-1)).toBe('2026-07-29 16:00');
  });

  it("never hides rows behind a reader's slow clock — clip is the floor", () => {
    const axis: SiteAxis = {
      siteId: 1,
      keys: hours('2026-07-29', 0, 23),
      clip: '2026-07-29 13:00',
    };
    const behind = visibleKeys(axis, 'hour', 'UTC', Date.parse('2026-07-29T11:00:00Z'));
    expect(behind.at(-1)).toBe('2026-07-29 13:00');
  });

  it('takes the local date as the ceiling for day, week and month keys', () => {
    const at = Date.parse('2026-07-29T12:00:00Z');
    const day: SiteAxis = { siteId: 1, keys: days('2026-07-28', '2026-07-29', '2026-07-30') };
    expect(visibleKeys(day, 'day', 'UTC', at)).toEqual(['2026-07-28', '2026-07-29']);
    const week: SiteAxis = { siteId: 1, keys: days('2026-07-20', '2026-07-27', '2026-08-03') };
    expect(visibleKeys(week, 'week', 'UTC', at)).toEqual(['2026-07-20', '2026-07-27']);
    const month: SiteAxis = { siteId: 1, keys: days('2026-06', '2026-07', '2026-08') };
    expect(visibleKeys(month, 'month', 'UTC', at)).toEqual(['2026-06', '2026-07']);
  });

  it('shows nothing of a window still entirely in the future', () => {
    const axis: SiteAxis = { siteId: 1, keys: days('2026-09-01', '2026-09-02') };
    expect(visibleKeys(axis, 'day', 'UTC', Date.parse('2026-07-29T12:00:00Z'))).toEqual([]);
  });
});

describe('visibleKeys across a DST transition', () => {
  /**
   * 2026-03-08 in New York: 01:59 EST jumps to 03:00 EDT. `local_hour` 2 cannot
   * exist, so the server's axis has no `02:00` key — and the reader's ceiling
   * must be a key that does, or the 03:00 bucket vanishes for an hour.
   */
  it('spring-forward: no fabricated 02:00, and 03:00 is reachable', () => {
    const keys = [...hours('2026-03-08', 0, 1), ...hours('2026-03-08', 3, 23)];
    const axis: SiteAxis = { siteId: 1, keys, clip: '2026-03-08 01:00' };
    // 07:30 UTC = 03:30 EDT, the first hour after the jump.
    const visible = visibleKeys(
      axis,
      'hour',
      'America/New_York',
      Date.parse('2026-03-08T07:30:00Z'),
    );
    expect(visible).not.toContain('2026-03-08 02:00');
    expect(visible.at(-1)).toBe('2026-03-08 03:00');
    expect(visible).toEqual(['2026-03-08 00:00', '2026-03-08 01:00', '2026-03-08 03:00']);
  });

  /**
   * 2026-11-01 in New York: 01:59 EDT falls back to 01:00 EST, so local hour 1
   * happens twice and both passes land in ONE bucket key. The second pass must
   * not read as the first: an axis frozen at `01:00` while the clock is on its
   * way to 02:00 is the "chart stopped an hour ago" bug.
   */
  it('fall-back: the doubled hour is one key, and the hours after it still appear', () => {
    const axis: SiteAxis = {
      siteId: 1,
      keys: hours('2026-11-01', 0, 23),
      clip: '2026-11-01 01:00',
    };
    // 05:30 UTC = 01:30 EDT (first pass) — 06:30 UTC = 01:30 EST (second pass).
    const first = visibleKeys(axis, 'hour', 'America/New_York', Date.parse('2026-11-01T05:30:00Z'));
    const second = visibleKeys(
      axis,
      'hour',
      'America/New_York',
      Date.parse('2026-11-01T06:30:00Z'),
    );
    expect(first.at(-1)).toBe('2026-11-01 01:00');
    expect(second.at(-1)).toBe('2026-11-01 01:00');
    expect(first).toEqual(second);
    // The 25-hour day still ends at 23:00, one key per local hour — 04:30 UTC
    // is 23:30 EST on the 1st, the last hour of the doubled-up day.
    const late = visibleKeys(axis, 'hour', 'America/New_York', Date.parse('2026-11-02T04:30:00Z'));
    expect(late).toHaveLength(24);
    expect(late.at(-1)).toBe('2026-11-01 23:00');
  });
});

describe('resultAxes', () => {
  const result = (axis?: SiteAxis[]): QueryResult => ({
    rows: [],
    ...(axis === undefined ? {} : { bucket: 'day' as const, axis }),
  });

  it('gives each site its own axis, on its own clock', () => {
    // 23:30 UTC on the 29th: Berlin is already on the 30th, New York is on the 29th.
    const now = Date.parse('2026-07-29T23:30:00Z');
    const windows = [
      window(1, 'Europe/Berlin', '2026-07-28', '2026-07-30'),
      window(2, 'America/New_York', '2026-07-27', '2026-07-29'),
    ];
    const axes = resultAxes(
      result([
        { siteId: 1, keys: days('2026-07-28', '2026-07-29', '2026-07-30'), clip: '2026-07-30' },
        { siteId: 2, keys: days('2026-07-27', '2026-07-28', '2026-07-29'), clip: '2026-07-29' },
      ]),
      windows,
      now,
    );
    expect(axes[0]?.keys.at(-1)).toBe('2026-07-30');
    expect(axes[1]?.keys.at(-1)).toBe('2026-07-29');
  });

  it('is empty when the server withheld an axis, so the rows are the axis', () => {
    expect(resultAxes(result(), [window(1, 'UTC', '2026-07-29')], Date.now())).toEqual([]);
  });
});

describe('sharedKeys', () => {
  it('unions the per-site axes for one shared-x chart, oldest first', () => {
    expect(
      sharedKeys([
        { siteId: 1, keys: ['2026-07-29', '2026-07-30'] },
        { siteId: 2, keys: ['2026-07-28', '2026-07-29'] },
      ]),
    ).toEqual(['2026-07-28', '2026-07-29', '2026-07-30']);
  });
});

describe('windowSpan', () => {
  it('spans every site in scope, because a midnight puts them on different days', () => {
    expect(
      windowSpan([
        window(1, 'UTC', '2026-06-30', '2026-07-29'),
        window(2, 'Asia/Tokyo', '2026-07-01', '2026-07-30'),
      ]),
    ).toEqual({ from: '2026-06-30', to: '2026-07-30' });
  });

  it('is undefined without windows', () => {
    expect(windowSpan(undefined)).toBeUndefined();
    expect(windowSpan([])).toBeUndefined();
  });
});
