import type { ResultRow } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { changeSections } from './changes.ts';

const row = (dim: string, value: string | null, current: number, delta: number): ResultRow => ({
  dim,
  value,
  current,
  previous: current - delta,
  delta,
  share: null,
});

describe('changeSections', () => {
  it('sizes each bar by its signed move against the section leader, half a track at most', () => {
    const [pages] = changeSections([
      row('path', '/?tab=globe', 7, 7),
      row('path', '/', 0, -3),
      row('path', '/about', 2, 1),
    ]);
    expect(pages?.rows.map((r) => [r.name, r.previous, r.current, r.delta, r.pct])).toEqual([
      ['/?tab=globe', 0, 7, 7, '50.0'],
      ['/', 3, 0, -3, '21.4'],
      ['/about', 1, 2, 1, '7.1'],
    ]);
  });

  it('keeps server order, splits sections by dim, and drops rows that did not move', () => {
    const sections = changeSections([
      row('ref_domain', null, 9, 5),
      row('ref_domain', 'bsky.app', 4, 0),
      row('country', 'VN', 0, -1),
    ]);
    expect(sections.map((s) => [s.dim, s.rows.map((r) => r.name)])).toEqual([
      ['ref_domain', ['Direct']],
      ['country', ['VN']],
    ]);
  });

  it('writes the share of the net change, and nothing when it has none', () => {
    const [section] = changeSections([
      { ...row('path', '/a', 6, 4), share: 0.8 },
      row('path', '/b', 2, 1),
    ]);
    expect(section?.rows.map((r) => r.share)).toEqual(['80%', '']);
  });
});
