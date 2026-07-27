import { describe, expect, it } from 'vitest';
import { barRows } from './bar-rows.ts';

describe('barRows', () => {
  it('ranks rows, scales bars against the leader, and carries the filter value', () => {
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
      { name: '/b', value: 200, extra: 0, pct: '100.0', filterValue: '/b' },
      { name: '/a', value: 50, extra: 0, pct: '25.0', filterValue: '/a' },
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
    expect(rows.map((row) => [row.name, row.value, row.filterValue])).toEqual([
      ['/', 378, '/'],
      ['/post', 20, '/post'],
    ]);
  });

  it('labels the null group and marks it for an is_null filter', () => {
    const rows = barRows(
      [
        { ref_domain: 'news.ycombinator.com?x=1', visitors: 5 },
        { ref_domain: null, visitors: 90 },
      ],
      'visitors',
      'ref_domain',
      'Direct',
    );
    expect(rows.map((row) => [row.name, row.filterValue])).toEqual([
      ['Direct', null],
      ['news.ycombinator.com?x=1', 'news.ycombinator.com?x=1'],
    ]);
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
    expect(rows.map((row) => [row.name, row.value])).toEqual([['example.com', 7]]);
  });

  it('composes dim · dim2 labels and sums the extra metric (events card)', () => {
    const rows = barRows(
      [
        { event_category: 'cta', event_action: 'click', events: 12, event_value_sum: 0 },
        { event_category: 'pricing', event_action: 'toggle', events: 4, event_value_sum: 4 },
        { event_category: 'signup', event_action: null, events: 3, event_value_sum: 0 },
      ],
      'events',
      'event_category',
      '(none)',
      { dim2: 'event_action', extraMetric: 'event_value_sum' },
    );
    expect(rows.map((row) => [row.name, row.value, row.extra, row.filterValue])).toEqual([
      ['cta · click', 12, 0, 'cta'],
      ['pricing · toggle', 4, 4, 'pricing'],
      ['signup', 3, 0, 'signup'],
    ]);
  });

  it('drops zero-value groups — including the non-event null group of an events breakdown', () => {
    const rows = barRows(
      [
        { event_category: null, event_action: null, events: 0 },
        { event_category: 'cta', event_action: 'click', events: 2 },
      ],
      'events',
      'event_category',
      '(none)',
      { dim2: 'event_action' },
    );
    expect(rows.map((row) => row.name)).toEqual(['cta · click']);
  });

  it('handles empty input and non-numeric cells', () => {
    expect(barRows([], 'pageviews', 'path', '(none)')).toEqual([]);
    expect(barRows([{ path: '/a', pageviews: null }], 'pageviews', 'path', '(none)')).toEqual([]);
  });
});
