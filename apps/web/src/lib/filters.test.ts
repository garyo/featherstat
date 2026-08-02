import type { Filter } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { chipLabel, parseFilter, parseFilters, sameFilters, serializeFilter } from './filters.ts';
import { applyViewState, DEFAULT_VIEW_STATE, parseViewState } from './state.ts';

describe('filter serialization', () => {
  const CASES: Filter[] = [
    { dim: 'path', op: 'eq', value: '/blog/post' },
    { dim: 'ref_domain', op: 'is_null' },
    { dim: 'country', op: 'eq', value: 'US' },
    { dim: 'path', op: 'contains', value: 'a:b,c%d e?f=g&h' },
    { dim: 'browser', op: 'in', value: ['Chrome', 'Sa:fa,ri'] },
    { dim: 'event_category', op: 'starts', value: 'sign' },
    { dim: 'title', op: 'neq', value: '404 — not found' },
    // A prop dim carries the one ':' a dimension may contain.
    { dim: 'prop:plan', op: 'eq', value: 'pro' },
    { dim: 'prop:ab_test', op: 'is_null' },
  ];

  it('round-trips every op, including hostile visitor-controlled values', () => {
    for (const filter of CASES) {
      expect(parseFilter(serializeFilter(filter))).toEqual(filter);
    }
  });

  it('drops what it cannot parse instead of failing', () => {
    for (const raw of [
      '',
      'path',
      'path:eq',
      'path:launch:/x',
      'nope:eq:v',
      'ref_domain:is_null:x',
    ]) {
      expect(parseFilter(raw)).toBeUndefined();
    }
    expect(parseFilters(['path:eq:%2Fa', 'garbage'])).toEqual([
      { dim: 'path', op: 'eq', value: '/a' },
    ]);
  });

  it('treats a stray percent as a literal, never a crash', () => {
    expect(parseFilter('path:eq:100%')).toEqual({ dim: 'path', op: 'eq', value: '100%' });
  });

  it('compares chip lists by value and order', () => {
    const a: Filter[] = [{ dim: 'country', op: 'eq', value: 'US' }];
    expect(sameFilters(a, [{ dim: 'country', op: 'eq', value: 'US' }])).toBe(true);
    expect(sameFilters(a, [{ dim: 'country', op: 'eq', value: 'DE' }])).toBe(false);
    expect(sameFilters(a, [])).toBe(false);
  });
});

describe('chips in the URL', () => {
  it('round-trips through a full view-state URL', () => {
    const filters: Filter[] = [
      { dim: 'country', op: 'eq', value: 'US' },
      { dim: 'ref_domain', op: 'is_null' },
      { dim: 'path', op: 'eq', value: '/x?a=1&b=2' },
    ];
    const state = { ...DEFAULT_VIEW_STATE, site: 4 as const, filters };
    const href = applyViewState(state, '/');
    expect(parseViewState(href)).toEqual(state);
  });

  it('writes no f params for an empty chip row and clears stale ones', () => {
    expect(applyViewState(DEFAULT_VIEW_STATE, '/?f=country:eq:US')).toBe('/');
  });
});

describe('chipLabel', () => {
  it('words each op and names the null group', () => {
    expect(chipLabel({ dim: 'country', op: 'eq', value: 'US' })).toBe('Country: US');
    expect(chipLabel({ dim: 'ref_domain', op: 'is_null' })).toBe('Referrer: Direct');
    expect(chipLabel({ dim: 'path', op: 'contains', value: 'blog' })).toBe('Page contains blog');
    expect(chipLabel({ dim: 'browser', op: 'in', value: ['Chrome', 'Edge'] })).toBe(
      'Browser in Chrome, Edge',
    );
  });

  it('names a prop dim by its bare key, null group included', () => {
    expect(chipLabel({ dim: 'prop:plan', op: 'eq', value: 'pro' })).toBe('plan: pro');
    expect(chipLabel({ dim: 'prop:plan', op: 'is_null' })).toBe('plan: (none)');
  });
});
