import { describe, expect, it } from 'vitest';
import { dwellBars, dwellRows } from './dwell.ts';

describe('dwellRows', () => {
  it('ranks pages by median dwell and scales the wash bar against the longest', () => {
    const rows = dwellRows([
      {
        path: '/',
        views_measured: 210,
        median_page_ms: 20_000,
        avg_page_ms: 23_000,
        max_page_ms: 180_000,
      },
      {
        path: '/blog',
        views_measured: 37,
        median_page_ms: 80_000,
        avg_page_ms: 92_000,
        max_page_ms: 740_000,
      },
    ]);
    expect(rows).toEqual([
      {
        path: '/blog',
        views: 37,
        medianMs: 80_000,
        avgMs: 92_000,
        maxMs: 740_000,
        scroll: undefined,
        scrolled: 0,
        pct: '100.0',
      },
      {
        path: '/',
        views: 210,
        medianMs: 20_000,
        avgMs: 23_000,
        maxMs: 180_000,
        scroll: undefined,
        scrolled: 0,
        pct: '25.0',
      },
    ]);
  });

  it('ranks by the median even where the average says otherwise', () => {
    const rows = dwellRows([
      { path: '/skewed', views_measured: 3, median_page_ms: 6_000, avg_page_ms: 16_700 },
      { path: '/steady', views_measured: 2, median_page_ms: 9_000, avg_page_ms: 9_000 },
    ]);
    expect(rows.map((row) => row.path)).toEqual(['/steady', '/skewed']);
  });

  it('drops rows nothing was measured for — the card never shows a fabricated zero', () => {
    const rows = dwellRows([
      { path: '/timed', views_measured: 2, avg_page_ms: 5_000, max_page_ms: 6_000 },
      { path: '/untimed', views_measured: 0, avg_page_ms: null, max_page_ms: null },
    ]);
    expect(rows.map((row) => row.path)).toEqual(['/timed']);
  });

  it('names a title-only pageview rather than rendering a blank row', () => {
    const rows = dwellRows([
      { path: '', views_measured: 1, avg_page_ms: 1_000, max_page_ms: 1000 },
    ]);
    expect(rows[0]?.path).toBe('(untitled)');
  });

  it('handles an empty answer', () => {
    expect(dwellRows([])).toEqual([]);
  });
});

describe('dwellBars', () => {
  const rows = dwellBars(
    dwellRows([
      {
        path: '/blog',
        views_measured: 1_400,
        median_page_ms: 41_000,
        avg_page_ms: 92_400,
        max_page_ms: 740_000,
      },
    ]),
  );

  it('writes the median as a duration, the average and max beside it', () => {
    expect(rows[0]).toMatchObject({
      name: '/blog',
      value: 41_000,
      pct: '100.0',
      text: '41s',
      sub: 'avg 1m 32s · max 12m 20s · 1,400 measured',
    });
  });

  it('carries its own tooltip, because its numbers are not a metric and its second metric', () => {
    expect(rows[0]?.tips).toEqual([
      { value: '41,000 ms', label: 'median' },
      { value: '92,400 ms', label: 'average' },
      { value: '740,000 ms', label: 'longest' },
      { value: '1,400', label: 'measured views' },
    ]);
  });

  it('renders no row as a filter: a session-scoped query cannot honour a path filter', () => {
    expect(rows[0]?.filterValue).toBeUndefined();
  });
});
