import type { ResultRow } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { deviceSegments } from './devices.ts';

describe('deviceSegments', () => {
  it('ranks the classic trio with capitalized names, shares and palette slots', () => {
    const rows: ResultRow[] = [
      { device_type: 'mobile', visitors: 33 },
      { device_type: 'desktop', visitors: 61 },
      { device_type: 'tablet', visitors: 6 },
    ];
    const segments = deviceSegments(rows, 'visitors');
    expect(segments.map((s) => [s.name, s.pct, s.slot, s.filterValue])).toEqual([
      ['Desktop', 61, 0, 'desktop'],
      ['Mobile', 33, 1, 'mobile'],
      ['Tablet', 6, 2, 'tablet'],
    ]);
    expect(segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(100);
  });

  it('folds past three segments — and the fold is not filterable', () => {
    const rows: ResultRow[] = [
      { device_type: 'desktop', visitors: 50 },
      { device_type: 'mobile', visitors: 30 },
      { device_type: 'tablet', visitors: 15 },
      { device_type: 'tv', visitors: 5 },
    ];
    const segments = deviceSegments(rows, 'visitors');
    expect(segments.map((s) => [s.name, s.value, s.filterValue])).toEqual([
      ['Desktop', 50, 'desktop'],
      ['Mobile', 30, 'mobile'],
      ['Other', 20, undefined],
    ]);
  });

  it('routes the null group and the enrichment "other" bucket into Other', () => {
    const rows: ResultRow[] = [
      { device_type: 'desktop', visitors: 8 },
      { device_type: 'other', visitors: 1 },
      { device_type: null, visitors: 1 },
    ];
    const segments = deviceSegments(rows, 'visitors');
    expect(segments.map((s) => [s.name, s.value])).toEqual([
      ['Desktop', 8],
      ['Other', 2],
    ]);
  });

  it('drops zero rows and survives empty input', () => {
    expect(deviceSegments([], 'visitors')).toEqual([]);
    expect(deviceSegments([{ device_type: 'desktop', visitors: 0 }], 'visitors')).toEqual([]);
  });
});
