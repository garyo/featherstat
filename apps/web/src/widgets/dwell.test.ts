import { describe, expect, it } from 'vitest';
import { dwellBars, dwellRows } from './dwell.ts';

describe('dwellRows', () => {
  it('ranks pages by average dwell and scales the wash bar against the longest', () => {
    const rows = dwellRows([
      { path: '/blog', views_measured: 37, avg_page_ms: 92_000, max_page_ms: 740_000 },
      { path: '/', views_measured: 210, avg_page_ms: 23_000, max_page_ms: 180_000 },
    ]);
    expect(rows).toEqual([
      {
        path: '/blog',
        views: 37,
        avgMs: 92_000,
        maxMs: 740_000,
        scroll: undefined,
        scrolled: 0,
        pct: '100.0',
      },
      {
        path: '/',
        views: 210,
        avgMs: 23_000,
        maxMs: 180_000,
        scroll: undefined,
        scrolled: 0,
        pct: '25.0',
      },
    ]);
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
      { path: '/blog', views_measured: 1_400, avg_page_ms: 92_400, max_page_ms: 740_000 },
    ]),
  );

  it('writes the average as a duration and says what it rests on', () => {
    expect(rows[0]).toMatchObject({
      name: '/blog',
      value: 92_400,
      pct: '100.0',
      text: '1m 32s',
      sub: 'max 12m 20s · 1,400 measured',
    });
  });

  it('carries its own tooltip, because its numbers are not a metric and its second metric', () => {
    expect(rows[0]?.tips).toEqual([
      { value: '92,400 ms', label: 'average' },
      { value: '740,000 ms', label: 'longest' },
      { value: '1,400', label: 'measured views' },
    ]);
  });

  it('renders no row as a filter: a session-scoped query cannot honour a path filter', () => {
    expect(rows[0]?.filterValue).toBeUndefined();
  });
});
