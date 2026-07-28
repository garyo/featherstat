import { MetricSchema, type QueryResponse } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  bucketedWindow,
  bucketLabel,
  bucketTitle,
  compactNumber,
  exactNumber,
  formatDuration,
  METRIC_LABELS,
  presetWindow,
} from './format.ts';

describe('presetWindow', () => {
  // 23:30 UTC: Berlin is already on the 28th — the window must follow the SITE's clock.
  const lateNight = new Date('2026-07-27T23:30:00Z');

  it('resolves presets to the site-local inclusive window, like the server does', () => {
    expect(presetWindow('today', 'UTC', lateNight)).toEqual({
      from: '2026-07-27',
      to: '2026-07-27',
    });
    expect(presetWindow('7d', 'UTC', lateNight)).toEqual({ from: '2026-07-21', to: '2026-07-27' });
    expect(presetWindow('30d', 'Europe/Berlin', lateNight)).toEqual({
      from: '2026-06-29',
      to: '2026-07-28',
    });
    expect(presetWindow('mtd', 'UTC', lateNight)).toEqual({ from: '2026-07-01', to: '2026-07-27' });
  });
});

describe('numbers (docs/05 § Numbers)', () => {
  it('shows small values exactly and compacts from 10K up', () => {
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(2847)).toBe('2,847');
    expect(compactNumber(10_000)).toBe('10K');
    expect(compactNumber(12_940)).toBe('12.9K');
    expect(compactNumber(1_000_000)).toBe('1M');
    expect(compactNumber(4_200_000)).toBe('4.2M');
  });

  it('keeps the exact form for tooltips', () => {
    expect(exactNumber(12_940)).toBe('12,940');
  });

  it('formats durations at the precision a dashboard needs', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(106_000)).toBe('1m 46s');
    expect(formatDuration(64_000)).toBe('1m 04s');
    expect(formatDuration(3_720_000)).toBe('1h 2m');
  });
});

describe('bucket labels', () => {
  it('labels day, hour and month buckets without timezone drift', () => {
    expect(bucketLabel('2026-07-05')).toBe('Jul 5');
    expect(bucketLabel('2026-07-27 14:00')).toBe('14:00');
    expect(bucketLabel('2026-07')).toBe('Jul 2026');
  });

  it('titles are fuller than labels', () => {
    expect(bucketTitle('2026-07-27')).toBe('Mon, Jul 27');
    expect(bucketTitle('2026-07-27 14:00')).toBe('Jul 27, 14:00');
  });

  it('passes unknown shapes through untouched', () => {
    expect(bucketLabel('whatever')).toBe('whatever');
  });
});

describe('bucketedWindow', () => {
  const meta = { generatedInMs: 1, dataVersion: 1 };

  it('spans the earliest to latest date across every bucketed result', () => {
    const response: QueryResponse = {
      results: {
        series: { rows: [{ bucket: '2026-06-28', visitors: 1 }] },
        spark: {
          rows: [
            { bucket: '2026-07-27', visitors: 2 },
            { bucket: '2026-07-01', visitors: 3 },
          ],
        },
        totals: { rows: [{ visitors: 6 }] },
        broken: { error: { code: 'unsupported', message: 'nope' } },
      },
      meta,
    };
    expect(bucketedWindow(response)).toEqual({ from: '2026-06-28', to: '2026-07-27' });
  });

  it('reads the date out of hour buckets', () => {
    const response: QueryResponse = {
      results: {
        series: {
          rows: [
            { bucket: '2026-07-27 09:00', visitors: 1 },
            { bucket: '2026-07-27 14:00', visitors: 2 },
          ],
        },
      },
      meta,
    };
    expect(bucketedWindow(response)).toEqual({ from: '2026-07-27', to: '2026-07-27' });
  });

  it('is undefined without a response or without any bucketed rows', () => {
    expect(bucketedWindow(undefined)).toBeUndefined();
    expect(bucketedWindow({ results: { t: { rows: [{ visitors: 1 }] } }, meta })).toBeUndefined();
  });
});

describe('metric labels', () => {
  it('covers the whole metric vocabulary', () => {
    for (const metric of MetricSchema.options) {
      expect(METRIC_LABELS[metric]).toBeTruthy();
    }
  });
});
