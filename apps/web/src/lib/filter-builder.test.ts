import type { SegmentFilterNode } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  describeFilter,
  emptyRow,
  leafOf,
  leavesOf,
  nodeOf,
  parseFilterJson,
  parseFilterListJson,
  rowsOf,
  rowsOfNodes,
} from './filter-builder.ts';

describe('leafOf', () => {
  it('builds a plain leaf and refuses an unknown dimension', () => {
    expect(leafOf({ dim: 'path', op: 'eq', value: '/pricing' })).toEqual({
      leaf: { dim: 'path', op: 'eq', value: '/pricing' },
    });
    expect(leafOf({ dim: 'nonsense', op: 'eq', value: 'x' })).toHaveProperty('error');
  });

  it('accepts prop dimensions — the vocabulary is open there', () => {
    expect(leafOf({ dim: 'prop:plan', op: 'eq', value: 'pro' })).toEqual({
      leaf: { dim: 'prop:plan', op: 'eq', value: 'pro' },
    });
  });

  it("splits 'in' on commas and drops empties", () => {
    expect(leafOf({ dim: 'country', op: 'in', value: 'US, DE,, FR ' })).toEqual({
      leaf: { dim: 'country', op: 'in', value: ['US', 'DE', 'FR'] },
    });
    expect(leafOf({ dim: 'country', op: 'in', value: ' , ' })).toHaveProperty('error');
  });

  it("gives 'is_null' no value and requires one everywhere else", () => {
    expect(leafOf({ dim: 'ref_domain', op: 'is_null', value: 'ignored' })).toEqual({
      leaf: { dim: 'ref_domain', op: 'is_null' },
    });
    expect(leafOf({ dim: 'path', op: 'contains', value: '' })).toHaveProperty('error');
  });
});

describe('rows ↔ tree round trip', () => {
  it('a lone row stays a bare leaf; several AND together', () => {
    const one = leavesOf([{ dim: 'path', op: 'eq', value: '/a' }]);
    if ('error' in one) throw new Error(one.error);
    expect(nodeOf(one.leaves)).toEqual({ dim: 'path', op: 'eq', value: '/a' });

    const two = leavesOf([
      { ...emptyRow(), value: '/a' },
      { dim: 'country', op: 'eq', value: 'US' },
    ]);
    if ('error' in two) throw new Error(two.error);
    const node = nodeOf(two.leaves);
    expect(node).toHaveProperty('all');
    expect(rowsOf(node)).toHaveLength(2);
  });

  it('reports which row failed', () => {
    const result = leavesOf([
      { dim: 'path', op: 'eq', value: '/a' },
      { dim: 'path', op: 'eq', value: '' },
    ]);
    expect(result).toEqual({ error: 'a value is required', row: 1 });
  });

  it('refuses to flatten what the rows cannot say', () => {
    const any: SegmentFilterNode = {
      any: [
        { dim: 'path', op: 'eq', value: '/a' },
        { dim: 'path', op: 'eq', value: '/b' },
      ],
    };
    expect(rowsOf(any)).toBeUndefined();
    expect(rowsOf({ not: { dim: 'country', op: 'eq', value: 'US' } })).toBeUndefined();
    expect(rowsOf({ dim: 'path', op: 'eq', value: '/a', scope: 'session' })).toBeUndefined();
    // Nested composition inside an `all` is just as unsayable.
    expect(rowsOf({ all: [any] })).toBeUndefined();
  });

  it('renders in-lists back as comma text', () => {
    expect(rowsOf({ dim: 'country', op: 'in', value: ['US', 'DE'] })).toEqual([
      { dim: 'country', op: 'in', value: 'US, DE' },
    ]);
  });

  it('handles a goal filter list only when every node is a plain leaf', () => {
    expect(
      rowsOfNodes([
        { dim: 'event_category', op: 'eq', value: 'signup' },
        { dim: 'path', op: 'starts', value: '/app' },
      ]),
    ).toHaveLength(2);
    expect(rowsOfNodes([{ not: { dim: 'path', op: 'eq', value: '/x' } }])).toBeUndefined();
  });
});

describe('advanced JSON parsing', () => {
  it('accepts a valid tree and rejects garbage through the shared grammar', () => {
    expect(parseFilterJson('{"dim":"path","op":"eq","value":"/a"}')).toEqual({
      node: { dim: 'path', op: 'eq', value: '/a' },
    });
    expect(parseFilterJson('not json')).toEqual({ error: 'not valid JSON' });
    expect(parseFilterJson('{"dim":"path","op":"regex","value":".*"}')).toHaveProperty('error');
    // Segment refs are request-side only — a stored tree may not carry one.
    expect(parseFilterJson('{"segment":3}')).toHaveProperty('error');
  });

  it('reads a goal list, promotes a bare tree to a list of one, refuses empty', () => {
    const list = parseFilterListJson('[{"dim":"path","op":"eq","value":"/a"}]');
    if ('error' in list) throw new Error(list.error);
    expect(list.nodes).toHaveLength(1);
    const bare = parseFilterListJson('{"dim":"path","op":"eq","value":"/a"}');
    if ('error' in bare) throw new Error(bare.error);
    expect(bare.nodes).toHaveLength(1);
    expect(parseFilterListJson('[]')).toHaveProperty('error');
  });
});

describe('describeFilter', () => {
  it('reads a tree back in words', () => {
    expect(
      describeFilter({
        all: [
          { dim: 'path', op: 'starts', value: '/blog' },
          { not: { dim: 'ref_domain', op: 'is_null' } },
        ],
      }),
    ).toBe('path starts with /blog and not (ref_domain is empty)');
    expect(describeFilter({ dim: 'path', op: 'eq', value: '/p', scope: 'session' })).toBe(
      'path is /p (in session)',
    );
  });
});
