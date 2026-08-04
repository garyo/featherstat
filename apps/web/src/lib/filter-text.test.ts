import type { FilterNode } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { parseFilterText, printFilterText } from './filter-text.ts';

/** The nodes, or an assertion failure quoting what the parser objected to. */
function parse(text: string, ids?: ReadonlyMap<string, number>): FilterNode[] {
  const result = parseFilterText(text, ids);
  if ('error' in result) {
    throw new Error(`${result.error.message} @${result.error.index} in ${text}`);
  }
  return result.nodes;
}

const SEGMENT_NAMES = new Map([[3, 'Paying customers']]);
const SEGMENT_IDS = new Map([['Paying customers', 3]]);

describe('round-trip', () => {
  const CASES: FilterNode[][] = [
    [{ dim: 'country', op: 'neq', value: 'SG' }],
    [
      { dim: 'country', op: 'neq', value: 'SG' },
      {
        any: [
          { dim: 'path', op: 'contains', value: '/blog' },
          { dim: 'path', op: 'starts', value: '/docs' },
        ],
      },
    ],
    [{ not: { any: [{ dim: 'country', op: 'eq', value: 'SG' }, { segment: 3 }] } }],
    [{ dim: 'path', op: 'eq', value: '/pricing', scope: 'session' }],
    [{ dim: 'browser', op: 'in', value: ['Chrome', 'Edge'] }],
    [{ dim: 'ref_domain', op: 'is_null' }],
    [{ dim: 'path', op: 'glob', value: '/blog/*/draft' }],
    [{ dim: 'prop:plan', op: 'eq', value: 'pro' }],
    [{ segment: 3 }],
    // Values that fight the tokenizer: quotes, backslashes, parens, keywords.
    [{ dim: 'title', op: 'eq', value: 'a "quoted" \\ (thing), and or not' }],
    [{ dim: 'title', op: 'eq', value: 'and' }],
    [{ dim: 'path', op: 'in', value: ['a,b', 'c)d'] }],
    // A `not` directly under the top-level AND.
    [{ dim: 'country', op: 'eq', value: 'US' }, { not: { dim: 'path', op: 'eq', value: '/' } }],
    [],
  ];

  it('parses back to exactly what was printed', () => {
    for (const nodes of CASES) {
      const text = printFilterText(nodes, SEGMENT_NAMES);
      expect(parse(text, SEGMENT_IDS), text).toEqual(nodes);
    }
  });

  /**
   * The one shape the round-trip canonicalises rather than preserves. A lone
   * top-level `{all: […]}` and the list `[…]` are the same implicit AND to the
   * query API, and the flat one is what the URL and `filter-tree.ts` already
   * produce — so text agrees with them rather than inventing a third shape.
   */
  it('flattens a lone top-level all, which means the same thing', () => {
    const wrapped: FilterNode[] = [
      {
        all: [
          { dim: 'country', op: 'eq', value: 'US' },
          { dim: 'path', op: 'eq', value: '/' },
        ],
      },
    ];
    expect(printFilterText(wrapped)).toBe('country = "US" and path = "/"');
    expect(parse(printFilterText(wrapped))).toEqual([
      { dim: 'country', op: 'eq', value: 'US' },
      { dim: 'path', op: 'eq', value: '/' },
    ]);
  });

  it('prints what a reader would write by hand', () => {
    expect(printFilterText(CASES[1] as FilterNode[])).toBe(
      'country != "SG" and (path contains "/blog" or path starts "/docs")',
    );
    expect(printFilterText([{ dim: 'ref_domain', op: 'is_null' }])).toBe('ref_domain is empty');
    expect(printFilterText([{ dim: 'browser', op: 'in', value: ['Chrome', 'Edge'] }])).toBe(
      'browser in ("Chrome", "Edge")',
    );
    expect(printFilterText([{ segment: 3 }], SEGMENT_NAMES)).toBe('segment "Paying customers"');
    expect(printFilterText([{ segment: 3 }])).toBe('segment 3');
  });
});

describe('reading what a person actually types', () => {
  it('takes unquoted values, and any capitalisation of the keywords', () => {
    expect(parse('country != SG AND path Contains /blog')).toEqual([
      { dim: 'country', op: 'neq', value: 'SG' },
      { dim: 'path', op: 'contains', value: '/blog' },
    ]);
  });

  it('accepts the friendly spellings of the operators', () => {
    expect(parse('path starts with /docs')).toEqual([
      { dim: 'path', op: 'starts', value: '/docs' },
    ]);
    expect(parse('country is US')).toEqual([{ dim: 'country', op: 'eq', value: 'US' }]);
    expect(parse('country is not US')).toEqual([{ dim: 'country', op: 'neq', value: 'US' }]);
    expect(parse("path = '/single quoted'")).toEqual([
      { dim: 'path', op: 'eq', value: '/single quoted' },
    ]);
  });

  it('binds not tighter than and, and and tighter than or', () => {
    expect(parse('country = US and path = /a or path = /b')).toEqual([
      {
        any: [
          {
            all: [
              { dim: 'country', op: 'eq', value: 'US' },
              { dim: 'path', op: 'eq', value: '/a' },
            ],
          },
          { dim: 'path', op: 'eq', value: '/b' },
        ],
      },
    ]);
    expect(parse('not country = US and path = /a')).toEqual([
      { not: { dim: 'country', op: 'eq', value: 'US' } },
      { dim: 'path', op: 'eq', value: '/a' },
    ]);
  });

  it('flattens a top-level and into the request’s own implicit AND', () => {
    expect(parse('country = US and path = /a')).toHaveLength(2);
    // …but an `or` at the top is ONE node: flattening it would change the meaning.
    expect(parse('country = US or path = /a')).toHaveLength(1);
  });

  it('reads an empty expression as no filter', () => {
    expect(parse('')).toEqual([]);
    expect(parse('   \n  ')).toEqual([]);
  });
});

describe('refusing, and saying where', () => {
  const cases: [string, RegExp][] = [
    ['nonsense = 1', /not a dimension/],
    ['country', /expected an operator/],
    ['country =', /expected a value/],
    ['(country = US', /closing \)/],
    ['country = US)', /unexpected/],
    ['country = "US', /unterminated quote/],
    ['country = and', /keyword — put it in quotes/],
    ['country is not empty', /no 'is not empty'/],
    ['browser in ()', /at least one value/],
    ['browser in (a b)', /expected , or \)/],
    ['segment "Nobody"', /no saved segment named/],
    ['segment 0', /expected a segment name/],
    ['country = US and', /expected a dimension/],
  ];

  it.each(cases)('refuses %s', (text, matcher) => {
    const result = parseFilterText(text, SEGMENT_IDS);
    if (!('error' in result)) throw new Error(`expected a refusal for: ${text}`);
    expect(result.error.message).toMatch(matcher);
    expect(result.error.index).toBeGreaterThanOrEqual(0);
    expect(result.error.index).toBeLessThanOrEqual(text.length);
  });

  it('points at the token that is wrong, not at the start', () => {
    const result = parseFilterText('country = US and nonsense = 1');
    if (!('error' in result)) throw new Error('expected a refusal');
    expect(result.error.index).toBe('country = US and '.length);
  });
});
