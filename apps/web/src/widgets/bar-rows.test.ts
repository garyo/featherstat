import { describe, expect, it } from 'vitest';
import { barRows } from './bar-rows.ts';

describe('barRows', () => {
  it('ranks rows and scales bars against the leader', () => {
    const rows = barRows(
      [
        { path: '/a', pageviews: 50 },
        { path: '/b', pageviews: 200 },
      ],
      'pageviews',
      'path',
      '(none)',
    );
    expect(rows).toEqual([
      { name: '/b', value: 200, pct: '100.0' },
      { name: '/a', value: 50, pct: '25.0' },
    ]);
  });

  it('collapses query-string variants of a path into one display row', () => {
    const rows = barRows(
      [
        { path: '/', pageviews: 361 },
        { path: '/?pk_source=sponsor&pk_medium=banner', pageviews: 9 },
        { path: '/?utm_source=newsletter', pageviews: 8 },
        { path: '/post', pageviews: 20 },
      ],
      'pageviews',
      'path',
      '(none)',
    );
    expect(rows.map((row) => [row.name, row.value])).toEqual([
      ['/', 378],
      ['/post', 20],
    ]);
  });

  it('leaves non-path dimensions unmerged and labels the null group', () => {
    const rows = barRows(
      [
        { ref_domain: 'news.ycombinator.com?x=1', visitors: 5 },
        { ref_domain: null, visitors: 90 },
      ],
      'visitors',
      'ref_domain',
      'Direct',
    );
    expect(rows.map((row) => row.name)).toEqual(['Direct', 'news.ycombinator.com?x=1']);
  });

  it('merges a null-label collision instead of rendering duplicate names', () => {
    const rows = barRows(
      [
        { ref_domain: 'example.com', visitors: 3 },
        { ref_domain: null, visitors: 4 },
      ],
      'visitors',
      'ref_domain',
      'example.com',
    );
    expect(rows).toEqual([{ name: 'example.com', value: 7, pct: '100.0' }]);
  });

  it('handles empty input and non-numeric cells', () => {
    expect(barRows([], 'pageviews', 'path', '(none)')).toEqual([]);
    expect(barRows([{ path: '/a', pageviews: null }], 'pageviews', 'path', '(none)')).toEqual([
      { name: '/a', value: 0, pct: '0.0' },
    ]);
  });
});
