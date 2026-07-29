import { describe, expect, it } from 'vitest';
import { num, seriesOf, sliceRanges } from './series.ts';

describe('num', () => {
  it('coerces result cells to chartable numbers', () => {
    expect(num(3)).toBe(3);
    expect(num(null)).toBe(0);
    expect(num('12')).toBe(0);
    expect(num(Number.NaN)).toBe(0);
  });
});

describe('seriesOf', () => {
  it('zero-fills every key of the axis, in axis order', () => {
    const rows = [
      { bucket: '2026-07-04', visitors: 5 },
      { bucket: '2026-07-01', visitors: 2 },
    ];
    const axis = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'];
    const points = seriesOf(rows, ['visitors'], axis);
    expect(points.map((point) => point.bucket)).toEqual(axis);
    expect(points.map((point) => point.values.visitors)).toEqual([2, 0, 0, 5]);
  });

  it('fills hour keys the same way — one enumerator, no bucket sniffing', () => {
    const rows = [
      { bucket: '2026-07-27 09:00', pageviews: 3 },
      { bucket: '2026-07-27 12:00', pageviews: 7 },
    ];
    const axis = [
      '2026-07-27 09:00',
      '2026-07-27 10:00',
      '2026-07-27 11:00',
      '2026-07-27 12:00',
      '2026-07-27 13:00',
    ];
    expect(seriesOf(rows, ['pageviews'], axis).map((point) => point.values.pageviews)).toEqual([
      3, 0, 0, 7, 0,
    ]);
  });

  it('fills week and month keys, which no client enumerator ever covered', () => {
    const weeks = seriesOf(
      [{ bucket: '2026-07-13', visitors: 4 }],
      ['visitors'],
      ['2026-07-06', '2026-07-13', '2026-07-20'],
    );
    expect(weeks.map((point) => point.values.visitors)).toEqual([0, 4, 0]);
    const months = seriesOf(
      [{ bucket: '2026-07', visitors: 9 }],
      ['visitors'],
      ['2026-05', '2026-06', '2026-07'],
    );
    expect(months.map((point) => point.values.visitors)).toEqual([0, 0, 9]);
  });

  it('still draws a row whose bucket is off the axis, in sorted position', () => {
    // The axis is what the server could enumerate, never a licence to drop an
    // answer it returned.
    const rows = [
      { bucket: '2026-06-30', visitors: 1 },
      { bucket: '2026-07-02', visitors: 2 },
    ];
    const points = seriesOf(rows, ['visitors'], ['2026-07-01', '2026-07-02']);
    expect(points.map((point) => point.bucket)).toEqual(['2026-06-30', '2026-07-01', '2026-07-02']);
  });

  it('falls back to the rows when there is no axis at all', () => {
    const rows = [
      { bucket: '2026-07', visitors: 9 },
      { bucket: '2026-05', visitors: 4 },
    ];
    expect(seriesOf(rows, ['visitors'], []).map((point) => point.bucket)).toEqual([
      '2026-05',
      '2026-07',
    ]);
  });

  it('drops rows without a bucket and handles empty input', () => {
    expect(seriesOf([], ['visitors'], [])).toEqual([]);
    expect(seriesOf([{ visitors: 3, bucket: null }], ['visitors'], [])).toEqual([]);
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
