import type { ResultRow } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { cellTitle, HEATMAP_HOURS, heatmapCells } from './heatmap.ts';

const cellAt = (cells: ReturnType<typeof heatmapCells>, day: number, hour: number) =>
  cells[day * HEATMAP_HOURS + hour];

describe('heatmapCells', () => {
  it('is a dense 7×24 grid in day-major render order', () => {
    const cells = heatmapCells([], 'pageviews');
    expect(cells).toHaveLength(168);
    expect(cells[0]).toEqual({ day: 0, hour: 0, value: 0, level: 0 });
    expect(cells[167]).toEqual({ day: 6, hour: 23, value: 0, level: 0 });
    expect(cells.every((cell) => cell.level === 0)).toBe(true);
  });

  it('maps strftime weekdays (0 = Sunday) onto Monday-first display rows', () => {
    const rows: ResultRow[] = [
      { local_hour: 9, weekday: 0, pageviews: 5 }, // Sunday → last row
      { local_hour: 9, weekday: 1, pageviews: 7 }, // Monday → first row
      { local_hour: 23, weekday: 6, pageviews: 3 }, // Saturday → row 5
    ];
    const cells = heatmapCells(rows, 'pageviews');
    expect(cellAt(cells, 6, 9)?.value).toBe(5);
    expect(cellAt(cells, 0, 9)?.value).toBe(7);
    expect(cellAt(cells, 5, 23)?.value).toBe(3);
  });

  it('keeps zero at level 0 and spreads non-zero values across quantile levels', () => {
    const rows: ResultRow[] = Array.from({ length: 20 }, (_, i) => ({
      local_hour: i,
      weekday: 1,
      pageviews: i + 1, // 1..20
    }));
    const cells = heatmapCells(rows, 'pageviews');
    const monday = cells.slice(0, HEATMAP_HOURS);
    expect(monday[20]?.level).toBe(0); // untouched hour recedes
    expect(monday[0]?.level).toBe(1); // faintest traffic still shows
    expect(monday[19]?.level).toBe(5); // hottest cell tops the ramp
    const levels = monday.slice(0, 20).map((cell) => cell.level);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels); // monotone with value
    expect(new Set(levels)).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('one outlier hour cannot wash the ordinary hours into one band', () => {
    const rows: ResultRow[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ local_hour: i, weekday: 2, pageviews: 10 + i })),
      { local_hour: 12, weekday: 2, pageviews: 100_000 },
    ];
    const cells = heatmapCells(rows, 'pageviews');
    const levels = new Set(cells.filter((c) => c.value > 0 && c.value < 100).map((c) => c.level));
    expect(levels.size).toBeGreaterThan(2);
  });

  it('sums duplicate (hour, weekday) rows and ignores malformed ones', () => {
    const rows: ResultRow[] = [
      { local_hour: 3, weekday: 4, pageviews: 2 },
      { local_hour: 3, weekday: 4, pageviews: 5 },
      { local_hour: 99, weekday: 4, pageviews: 100 },
      { local_hour: null, weekday: 4, pageviews: 100 },
      { local_hour: 3, weekday: 'x', pageviews: 100 },
    ];
    expect(cellAt(heatmapCells(rows, 'pageviews'), 3, 3)?.value).toBe(7);
  });
});

describe('cellTitle', () => {
  it('names the display day and zero-pads the hour range', () => {
    expect(cellTitle({ day: 0, hour: 9, value: 1, level: 1 })).toBe('Mon 09:00–09:59');
    expect(cellTitle({ day: 6, hour: 23, value: 1, level: 1 })).toBe('Sun 23:00–23:59');
  });
});
