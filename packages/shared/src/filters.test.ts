import { describe, expect, it } from 'vitest';
import {
  DimensionSchema,
  type FilterLeaf,
  FilterLeafSchema,
  type FilterNode,
  FilterNodeSchema,
  FiltersSchema,
  filterDims,
  filterLeaves,
  filterSegmentRefs,
  isPropDimension,
  MAX_FILTER_DEPTH,
  MAX_FILTER_LEAVES,
  MAX_GLOB_WILDCARDS,
  propKeyOf,
  QueryRequestSchema,
  SegmentFilterNodeSchema,
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

describe('prop:<key> dimensions', () => {
  it('accepts a prop dim in queries and filter leaves', () => {
    expect(DimensionSchema.safeParse('prop:plan').success).toBe(true);
    expect(FilterLeafSchema.safeParse({ dim: 'prop:plan', op: 'eq', value: 'pro' }).success).toBe(
      true,
    );
    const req = QueryRequestSchema.safeParse({
      site: 1,
      range: { preset: '7d' },
      queries: [{ id: 'q', metrics: ['pageviews'], dim: 'prop:ab_test' }],
    });
    expect(req.success).toBe(true);
  });

  it('400s a key outside the charset — the injection surface stays closed', () => {
    for (const hostile of [
      'prop:', // empty key
      'prop:Bad Key',
      'prop:a"||(SELECT 1)||"', // a quote can never reach the bound path
      `prop:${'a'.repeat(33)}`,
      'props:plan',
    ]) {
      expect(DimensionSchema.safeParse(hostile).success, hostile).toBe(false);
    }
  });

  it('isPropDimension / propKeyOf split the union the exhaustive tables key on', () => {
    expect(isPropDimension('prop:plan')).toBe(true);
    expect(isPropDimension('path')).toBe(false);
    expect(propKeyOf('prop:plan')).toBe('plan');
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

describe('segment refs — request grammar only', () => {
  it('accepts a {segment} leaf anywhere in a request filter tree', () => {
    expect(FilterNodeSchema.safeParse({ segment: 3 }).success).toBe(true);
    expect(
      FilterNodeSchema.safeParse({
        any: [{ segment: 3 }, { dim: 'country', op: 'eq', value: 'US' }],
      }).success,
    ).toBe(true);
    expect(FilterNodeSchema.safeParse({ not: { segment: 3 } }).success).toBe(true);
  });

  it('rejects non-positive and non-integer segment ids', () => {
    for (const bad of [0, -1, 1.5, 'x']) {
      expect(FilterNodeSchema.safeParse({ segment: bad }).success, String(bad)).toBe(false);
    }
  });

  it('rejects segment refs in a STORED segment definition — no cycles by construction', () => {
    expect(SegmentFilterNodeSchema.safeParse({ segment: 3 }).success).toBe(false);
    // Nested anywhere is just as refused: a cycle cannot be stored at any depth.
    expect(
      SegmentFilterNodeSchema.safeParse({
        all: [{ dim: 'country', op: 'eq', value: 'US' }, { not: { segment: 3 } }],
      }).success,
    ).toBe(false);
    // The same tree without the ref is fine — the grammar differs only there.
    expect(
      SegmentFilterNodeSchema.safeParse({
        all: [
          { dim: 'country', op: 'eq', value: 'US' },
          { not: { dim: 'ref_type', op: 'eq', value: 'internal' } },
        ],
      }).success,
    ).toBe(true);
  });

  it('walks refs with filterSegmentRefs and gives them no leaves', () => {
    const tree = {
      all: [{ segment: 3 }, { any: [{ segment: 7 }, { dim: 'country', op: 'eq', value: 'US' }] }],
    } as FilterNode;
    expect(filterSegmentRefs(tree)).toEqual([3, 7]);
    expect(filterLeaves(tree)).toEqual([{ dim: 'country', op: 'eq', value: 'US' }]);
  });
});
