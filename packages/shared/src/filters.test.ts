import { describe, expect, it } from 'vitest';
import {
  type FilterLeaf,
  FilterLeafSchema,
  type FilterNode,
  FilterNodeSchema,
  FiltersSchema,
  filterDims,
  filterLeaves,
  MAX_FILTER_DEPTH,
  MAX_FILTER_LEAVES,
  MAX_GLOB_WILDCARDS,
  QueryRequestSchema,
} from './index.ts';

const leaf = (value: string): FilterLeaf => ({ dim: 'path', op: 'eq', value });

describe('FilterLeafSchema', () => {
  it('keeps the v1 op/value contract: is_null takes no value, the rest require one', () => {
    expect(FilterLeafSchema.safeParse({ dim: 'ref_domain', op: 'is_null' }).success).toBe(true);
    expect(
      FilterLeafSchema.safeParse({ dim: 'ref_domain', op: 'is_null', value: 'x' }).success,
    ).toBe(false);
    expect(FilterLeafSchema.safeParse({ dim: 'country', op: 'eq' }).success).toBe(false);
  });

  it('accepts a scope and nothing outside the two-word vocabulary', () => {
    expect(FilterLeafSchema.safeParse({ ...leaf('/'), scope: 'session' }).success).toBe(true);
    expect(FilterLeafSchema.safeParse({ ...leaf('/'), scope: 'hit' }).success).toBe(true);
    expect(FilterLeafSchema.safeParse({ ...leaf('/'), scope: 'visit' }).success).toBe(false);
  });

  it('caps a glob pattern at 256 characters and 8 wildcards, single string only', () => {
    const ok = { dim: 'path', op: 'glob', value: '/docs/*' };
    expect(FilterLeafSchema.safeParse(ok).success).toBe(true);

    const tooLong = { ...ok, value: `/${'a'.repeat(256)}` };
    expect(FilterLeafSchema.safeParse(tooLong).success).toBe(false);

    const maxStars = { ...ok, value: '*a'.repeat(MAX_GLOB_WILDCARDS) };
    expect(FilterLeafSchema.safeParse(maxStars).success).toBe(true);
    const tooManyStars = { ...ok, value: '*a'.repeat(MAX_GLOB_WILDCARDS + 1) };
    expect(FilterLeafSchema.safeParse(tooManyStars).success).toBe(false);

    const list = { ...ok, value: ['/a*', '/b*'] };
    expect(FilterLeafSchema.safeParse(list).success).toBe(false);
  });
});

describe('FilterNodeSchema', () => {
  it('parses all/any/not composition over leaves', () => {
    const node: FilterNode = {
      any: [leaf('/a'), { all: [leaf('/b'), { not: { dim: 'country', op: 'is_null' } }] }],
    };
    expect(FilterNodeSchema.parse(node)).toEqual(node);
  });

  it('rejects an empty group: `all: []` and `any: []` answer nothing decidable', () => {
    expect(FilterNodeSchema.safeParse({ all: [] }).success).toBe(false);
    expect(FilterNodeSchema.safeParse({ any: [] }).success).toBe(false);
  });
});

describe('FiltersSchema', () => {
  it('still accepts a v1 flat array of leaves, byte for byte', () => {
    const v1 = [
      { dim: 'country', op: 'eq', value: 'US' },
      { dim: 'ref_domain', op: 'is_null' },
      { dim: 'country', op: 'in', value: ['US', 'DE'] },
    ];
    expect(FiltersSchema.parse(v1)).toEqual(v1);
  });

  it('a v1-shaped QueryRequest is valid input unchanged', () => {
    const request = {
      site: 1,
      range: { preset: '7d' },
      filters: [{ dim: 'country', op: 'eq', value: 'US' }],
      queries: [
        {
          id: 'q',
          metrics: ['pageviews'],
          filters: [{ dim: 'path', op: 'starts', value: '/docs' }],
        },
      ],
    };
    const parsed = QueryRequestSchema.parse(request);
    expect(parsed.filters).toEqual(request.filters);
    expect(parsed.queries[0]).toMatchObject({ filters: request.queries[0]?.filters });
  });

  it(`caps nesting at ${MAX_FILTER_DEPTH} levels`, () => {
    let node: FilterNode = leaf('/'); // depth 1
    for (let i = 1; i < MAX_FILTER_DEPTH; i += 1) node = { not: node };
    expect(FiltersSchema.safeParse([node]).success).toBe(true);
    expect(FiltersSchema.safeParse([{ not: node }]).success).toBe(false);
  });

  it(`caps the whole tree at ${MAX_FILTER_LEAVES} leaves`, () => {
    const leaves = (count: number) => Array.from({ length: count }, (_, i) => leaf(`/${i}`));
    expect(FiltersSchema.safeParse([{ any: leaves(MAX_FILTER_LEAVES) }]).success).toBe(true);
    // The count spans siblings: a wide `any` plus one more top-level leaf tips it.
    expect(FiltersSchema.safeParse([{ any: leaves(MAX_FILTER_LEAVES) }, leaf('/x')]).success).toBe(
      false,
    );
  });
});

describe('tree helpers', () => {
  const tree: FilterNode = {
    any: [
      { dim: 'country', op: 'eq', value: 'US' },
      { all: [leaf('/a'), { not: { dim: 'ref_domain', op: 'is_null' } }] },
    ],
  };

  it('filterLeaves lists every leaf in document order', () => {
    expect(filterLeaves(tree).map((l) => l.dim)).toEqual(['country', 'path', 'ref_domain']);
    expect(filterLeaves(leaf('/x'))).toEqual([leaf('/x')]);
  });

  it('filterDims collects every dimension mentioned anywhere', () => {
    expect(filterDims(tree)).toEqual(new Set(['country', 'path', 'ref_domain']));
  });
});
