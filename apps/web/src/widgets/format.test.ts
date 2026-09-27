import { MetricSchema, type SiteWindow } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  bucketLabel,
  bucketTitle,
  compactNumber,
  exactNumber,
  formatDuration,
  METRIC_LABELS,
  windowLabel,
  zoneLabel,
} from './format.ts';

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

describe('windowLabel', () => {
  const window = (siteId: number, from: string, to: string): SiteWindow => ({
    siteId,
    timezone: 'UTC',
    from,
    to,
  });

  it('reads the label straight off the server-resolved windows', () => {
    expect(windowLabel([window(1, '2026-06-30', '2026-07-29')])).toBe('Jun 30 \u2013 Jul 29');
  });

  it('names a single day once, not as a range of itself', () => {
    expect(windowLabel([window(1, '2026-07-29', '2026-07-29')])).toBe('Jul 29');
  });

  it("spans every site's window, because a midnight puts them on different days", () => {
    expect(
      windowLabel([window(1, '2026-06-30', '2026-07-29'), window(2, '2026-07-01', '2026-07-30')]),
    ).toBe('Jun 30 \u2013 Jul 30');
  });

  it('is undefined before the first response, so the caller words its own placeholder', () => {
    expect(windowLabel(undefined)).toBeUndefined();
    expect(windowLabel([])).toBeUndefined();
  });
});

describe('zoneLabel', () => {
  const window = (siteId: number, timezone: string): SiteWindow => ({
    siteId,
    timezone,
    from: '2026-07-01',
    to: '2026-07-30',
  });

  it('names the one clock the hours on screen keep', () => {
    expect(zoneLabel([window(1, 'America/New_York')])).toBe('New York time');
    expect(zoneLabel([window(1, 'America/Argentina/Buenos_Aires')])).toBe('Buenos Aires time');
    expect(zoneLabel([window(1, 'UTC')])).toBe('UTC');
  });

  it('says each site keeps its own when a batch spans zones', () => {
    expect(zoneLabel([window(1, 'Europe/Paris'), window(2, 'Pacific/Auckland')])).toBe(
      "each site's local time",
    );
    expect(zoneLabel([window(1, 'Europe/Paris'), window(2, 'Europe/Paris')])).toBe('Paris time');
  });

  it('is undefined before the first response', () => {
    expect(zoneLabel(undefined)).toBeUndefined();
  });
});

describe('metric labels', () => {
  it('covers the whole metric vocabulary', () => {
    for (const metric of MetricSchema.options) {
      expect(METRIC_LABELS[metric]).toBeTruthy();
    }
  });
});
