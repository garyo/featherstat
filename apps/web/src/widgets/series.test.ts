import { describe, expect, it } from 'vitest';
import { addDaysIso, fillBuckets, num, sliceRanges } from './series.ts';

describe('num', () => {
  it('coerces result cells to chartable numbers', () => {
    expect(num(3)).toBe(3);
    expect(num(null)).toBe(0);
    expect(num('12')).toBe(0);
    expect(num(Number.NaN)).toBe(0);
  });
});

describe('addDaysIso', () => {
  it('crosses month and year boundaries in plain UTC math', () => {
    expect(addDaysIso('2026-07-01', -1)).toBe('2026-06-30');
    expect(addDaysIso('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDaysIso('2026-07-27', -7)).toBe('2026-07-20');
  });
});

describe('fillBuckets', () => {
  it('zero-fills missing days and sorts by bucket', () => {
    const rows = [
      { bucket: '2026-07-04', visitors: 5 },
      { bucket: '2026-07-01', visitors: 2 },
    ];
    const points = fillBuckets(rows, ['visitors']);
    expect(points.map((p) => p.bucket)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
    ]);
    expect(points.map((p) => p.values.visitors)).toEqual([2, 0, 0, 5]);
  });

  it('zero-fills hour gaps within a single day', () => {
    const rows = [
      { bucket: '2026-07-27 09:00', pageviews: 3 },
      { bucket: '2026-07-27 12:00', pageviews: 7 },
    ];
    const points = fillBuckets(rows, ['pageviews']);
    expect(points.map((p) => p.bucket)).toEqual([
      '2026-07-27 09:00',
      '2026-07-27 10:00',
      '2026-07-27 11:00',
      '2026-07-27 12:00',
    ]);
    expect(points.map((p) => p.values.pageviews)).toEqual([3, 0, 0, 7]);
  });

  it('passes other bucket shapes through in sorted order', () => {
    const rows = [
      { bucket: '2026-07', visitors: 9 },
      { bucket: '2026-05', visitors: 4 },
    ];
    expect(fillBuckets(rows, ['visitors']).map((p) => p.bucket)).toEqual(['2026-05', '2026-07']);
  });

  it('drops rows without a bucket and handles empty input', () => {
    expect(fillBuckets([], ['visitors'])).toEqual([]);
    expect(fillBuckets([{ visitors: 3, bucket: null }], ['visitors'])).toEqual([]);
  });

  it('pads a day series out to the requested window — quiet edges must not shrink the chart', () => {
    const rows = [{ bucket: '2026-07-03', visitors: 5 }];
    const points = fillBuckets(rows, ['visitors'], { from: '2026-07-01', to: '2026-07-05' });
    expect(points.map((p) => p.bucket)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
    ]);
    expect(points.map((p) => p.values.visitors)).toEqual([0, 0, 5, 0, 0]);
  });

  it('never truncates data that spills past the window', () => {
    const rows = [
      { bucket: '2026-06-30', visitors: 1 },
      { bucket: '2026-07-02', visitors: 2 },
    ];
    const points = fillBuckets(rows, ['visitors'], { from: '2026-07-01', to: '2026-07-02' });
    expect(points[0]?.bucket).toBe('2026-06-30');
    expect(points.at(-1)?.bucket).toBe('2026-07-02');
  });
});

describe('sliceRanges', () => {
  it('splits n points into at most the asked number of contiguous slices', () => {
    const ranges = sliceRanges(30, 12);
    expect(ranges).toHaveLength(12);
    expect(ranges[0]?.[0]).toBe(0);
    expect(ranges[11]?.[1]).toBe(30);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]?.[0]).toBe(ranges[i - 1]?.[1]); // contiguous, non-overlapping
    }
  });

  it('degrades to one slice per point when there are few points', () => {
    expect(sliceRanges(5, 12)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
  });
});

describe('fillBuckets hour padding', () => {
  const hour = (h: number, visitors: number) => ({
    bucket: `2026-07-29 ${String(h).padStart(2, '0')}:00`,
    visitors,
  });

  it('pads an hour series out to the requested window, not the last hit', () => {
    // Hits stopped at 11:00; it is now 13:00. The quiet hours are the point.
    const series = fillBuckets([hour(9, 4), hour(11, 2)], ['visitors'], {
      from: '2026-07-29 00:00',
      to: '2026-07-29 13:00',
    });
    expect(series).toHaveLength(14);
    expect(series[0]).toEqual({ bucket: '2026-07-29 00:00', values: { visitors: 0 } });
    expect(series.at(-1)).toEqual({ bucket: '2026-07-29 13:00', values: { visitors: 0 } });
    expect(series[9]?.values.visitors).toBe(4);
  });

  it('pads a single-hour series too, rather than drawing one point', () => {
    const series = fillBuckets([hour(2, 7)], ['visitors'], {
      from: '2026-07-29 00:00',
      to: '2026-07-29 04:00',
    });
    expect(series.map((point) => point.values.visitors)).toEqual([0, 0, 7, 0, 0]);
  });

  it('ignores a date-shaped window for an hour series', () => {
    const series = fillBuckets([hour(9, 1), hour(10, 1)], ['visitors'], {
      from: '2026-07-01',
      to: '2026-07-29',
    });
    expect(series).toHaveLength(2);
  });
});
