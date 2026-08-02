import { describe, expect, it } from 'vitest';
import { histogramBars } from './histogram.ts';

describe('histogramBars', () => {
  it('keeps dwell bands as sent — server order, sparse stays sparse', () => {
    const bars = histogramBars(
      [
        { bucket: '0–10s', legs: 40 },
        { bucket: '30–60s', legs: 10 },
      ],
      'dwell',
    );
    expect(bars.map((bar) => bar.label)).toEqual(['0–10s', '30–60s']);
    expect(bars.map((bar) => bar.pct)).toEqual([100, 25]);
  });

  it('fills scroll deciles to all ten, so the axis is stable across responses', () => {
    const bars = histogramBars(
      [
        { bucket: 0, legs: 5 },
        { bucket: 9, legs: 20 },
      ],
      'scroll',
    );
    expect(bars).toHaveLength(10);
    expect(bars[0]).toEqual({ label: '0–10%', value: 5, pct: 25 });
    expect(bars[9]).toEqual({ label: '90–100%', value: 20, pct: 100 });
    expect(bars[4]).toEqual({ label: '40–50%', value: 0, pct: 0 });
  });

  it('ignores out-of-range decile keys rather than crashing on odd rows', () => {
    const bars = histogramBars([{ bucket: 12, legs: 5 }], 'scroll');
    expect(bars.every((bar) => bar.value === 0)).toBe(true);
  });

  it('an empty result yields no bars for dwell and ten empty ones for scroll', () => {
    expect(histogramBars([], 'dwell')).toEqual([]);
    expect(histogramBars([], 'scroll')).toHaveLength(10);
  });
});
