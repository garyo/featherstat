import {
  type Filter,
  type FilterNode,
  filterDepth,
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
} from '@featherstat/shared';
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

describe('expressions in the URL', () => {
  const TREES: FilterNode[] = [
    {
      all: [
        { dim: 'country', op: 'neq', value: 'SG' },
        {
          any: [
            { dim: 'path', op: 'contains', value: '/blog' },
            { dim: 'path', op: 'starts', value: '/docs' },
          ],
        },
      ],
    },
    { not: { dim: 'ref_domain', op: 'is_null' } },
    { any: [{ dim: 'browser', op: 'eq', value: 'Chrome' }] },
    // A leaf that names `scope` has no flat spelling, so it takes the `~` one.
    { dim: 'path', op: 'eq', value: '/pricing', scope: 'session' },
    // Values the flat spelling would have to escape, now inside JSON instead.
    { not: { dim: 'title', op: 'eq', value: 'a:b,c%d — e?f=g&h~i' } },
    { segment: 7 },
  ];

  it('round-trips every shape a leaf cannot say', () => {
    for (const node of TREES) {
      expect(parseFilter(serializeFilter(node))).toEqual(node);
    }
  });

  it('keeps the flat spelling for plain leaves, so old links still read', () => {
    expect(serializeFilter({ dim: 'country', op: 'neq', value: 'SG' })).toBe('country:neq:SG');
    expect(serializeFilter({ segment: 3 })).toBe('segment:3');
    expect(serializeFilter({ not: { dim: 'country', op: 'eq', value: 'SG' } })).toMatch(/^~/);
  });

  it('still parses every link written before expressions existed', () => {
    expect(parseFilters(['country:neq:SG', 'ref_domain:is_null', 'prop:plan:eq:pro'])).toEqual([
      { dim: 'country', op: 'neq', value: 'SG' },
      { dim: 'ref_domain', op: 'is_null' },
      { dim: 'prop:plan', op: 'eq', value: 'pro' },
    ]);
  });

  it('drops a hostile or malformed payload rather than throwing', () => {
    for (const raw of ['~', '~!!!!', '~e30', 'segment:0', 'segment:x', 'segment:-1']) {
      expect(parseFilter(raw)).toBeUndefined();
    }
  });

  it('refuses an over-cap link but keeps the part of it that fits', () => {
    const deep: FilterNode = {
      not: { not: { not: { not: { dim: 'path', op: 'eq', value: '/' } } } },
    };
    expect(filterDepth(deep)).toBeGreaterThan(MAX_FILTER_DEPTH);
    expect(parseFilters([serializeFilter(deep), 'country:eq:US'])).toEqual([
      { dim: 'country', op: 'eq', value: 'US' },
    ]);
    const many = Array.from({ length: MAX_FILTER_NODES + 4 }, (_, i) => `country:eq:C${i}`);
    expect(parseFilters(many)).toHaveLength(MAX_FILTER_NODES);
  });

  it('round-trips an expression through a full view-state URL', () => {
    const state = { ...DEFAULT_VIEW_STATE, site: 2 as const, filters: TREES };
    expect(parseViewState(applyViewState(state, '/'))).toEqual(state);
  });
});

describe('chipLabel over an expression', () => {
  it('joins by the word the group means and parenthesizes what is nested', () => {
    expect(
      chipLabel({
        all: [
          { dim: 'country', op: 'neq', value: 'SG' },
          {
            any: [
              { dim: 'path', op: 'contains', value: '/blog' },
              { dim: 'path', op: 'starts', value: '/docs' },
            ],
          },
        ],
      }),
    ).toBe('Country not SG and (Page contains /blog or Page starts with /docs)');
  });

  it('says what a bare not and a session-scoped leaf mean', () => {
    expect(chipLabel({ not: { dim: 'country', op: 'eq', value: 'SG' } })).toBe('not Country: SG');
    expect(chipLabel({ dim: 'path', op: 'eq', value: '/pricing', scope: 'session' })).toBe(
      'Page (session): /pricing',
    );
  });

  it('names a segment when it can and numbers it when it cannot', () => {
    expect(chipLabel({ segment: 3 }, new Map([[3, 'Paying customers']]))).toBe('Paying customers');
    expect(chipLabel({ segment: 3 })).toBe('Segment 3');
  });
});
