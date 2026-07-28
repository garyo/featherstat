import type { ResultRow } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { TOP_PAGES, topPages } from './top-pages.ts';

const WINDOW_DAYS = 14;

const TODAY = '2026-07-27';

/** `daysAgo` 0 = today. */
const row = (path: string, daysAgo: number, pageviews: number): ResultRow => {
  const ms = Date.parse(`${TODAY}T00:00:00Z`) - daysAgo * 86_400_000;
  return { path, bucket: new Date(ms).toISOString().slice(0, 10), pageviews };
};

/** The card's enumerated window: WINDOW_DAYS days ending on TODAY, oldest first. */
const BUCKETS = Array.from({ length: WINDOW_DAYS }, (_, i) => {
  const ms = Date.parse(`${TODAY}T00:00:00Z`) - (WINDOW_DAYS - 1 - i) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
});

describe('topPages', () => {
  it('ranks by trend-window total and caps at three pages', () => {
    const rows: ResultRow[] = [
      row('/a', 0, 10),
      row('/b', 1, 30),
      row('/c', 2, 20),
      row('/d', 3, 5),
    ];
    const pages = topPages(rows, BUCKETS);
    expect(pages).toHaveLength(TOP_PAGES);
    expect(pages.map((page) => page.path)).toEqual(['/b', '/c', '/a']);
  });

  it('zero-fills the spark across the window, oldest first', () => {
    const pages = topPages([row('/a', 0, 7), row('/a', 13, 3)], BUCKETS);
    const spark = pages[0]?.spark;
    expect(spark).toHaveLength(WINDOW_DAYS);
    expect(spark?.[0]).toBe(3);
    expect(spark?.[WINDOW_DAYS - 1]).toBe(7);
    expect(spark?.slice(1, -1).every((value) => value === 0)).toBe(true);
  });

  it('computes the delta as recent half vs previous half', () => {
    const rows: ResultRow[] = [
      ...Array.from({ length: 7 }, (_, i) => row('/a', i, 20)), // recent 7 days: 140
      ...Array.from({ length: 7 }, (_, i) => row('/a', i + 7, 10)), // previous 7: 70
    ];
    expect(topPages(rows, BUCKETS)[0]?.deltaPct).toBe(100);
  });

  it('reports no delta without a baseline, and merges campaign variants of a page', () => {
    const rows: ResultRow[] = [
      row('/launch', 0, 8),
      { ...row('/launch', 0, 4), path: '/launch?utm_source=hn' },
    ];
    const pages = topPages(rows, BUCKETS);
    expect(pages).toEqual([
      {
        path: '/launch',
        total: 12,
        spark: [...Array.from({ length: WINDOW_DAYS - 1 }, () => 0), 12],
        deltaPct: undefined,
      },
    ]);
  });

  it('drops pages with no traffic inside the window and tolerates junk rows', () => {
    const rows: ResultRow[] = [
      row('/old', 20, 500), // outside the window
      { path: null, bucket: TODAY, pageviews: 9 },
      { path: '/ok', bucket: null, pageviews: 9 },
      row('/live', 1, 2),
    ];
    expect(topPages(rows, BUCKETS).map((page) => page.path)).toEqual(['/live']);
  });
});
