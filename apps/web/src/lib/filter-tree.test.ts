import { type FilterNode, MAX_FILTER_LEAVES, MAX_FILTER_NODES } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  type DraftGroup,
  draftOfNodes,
  groupDraft,
  insertAt,
  leafDraft,
  nodeAt,
  nodesOf,
  removeAt,
  segmentDraft,
  setGroupOp,
  toggleNegated,
  unwrapAt,
  wrapAt,
} from './filter-tree.ts';

/** The wire nodes a draft answers, or the assertion fails saying what refused. */
function nodes(root: DraftGroup): FilterNode[] {
  const result = nodesOf(root);
  if ('error' in result) throw new Error(`${result.error.message} at [${result.error.path}]`);
  return result.nodes;
}

const EXPRESSION: FilterNode[] = [
  { dim: 'country', op: 'neq', value: 'SG' },
  {
    any: [
      { dim: 'path', op: 'contains', value: '/blog' },
      { dim: 'path', op: 'starts', value: '/docs' },
    ],
  },
];

describe('draft round-trip', () => {
  it('survives every shape the grammar can hold', () => {
    const cases: FilterNode[][] = [
      EXPRESSION,
      [{ not: { any: [{ dim: 'country', op: 'eq', value: 'SG' }, { segment: 4 }] } }],
      [{ dim: 'path', op: 'eq', value: '/pricing', scope: 'session' }],
      [{ dim: 'browser', op: 'in', value: ['Chrome', 'Edge'] }],
      [{ dim: 'ref_domain', op: 'is_null' }],
      [{ segment: 2 }],
      [],
    ];
    for (const original of cases) {
      expect(nodes(draftOfNodes(original))).toEqual(original);
    }
  });

  it('negates a bare leaf by giving it the group that carries the flag', () => {
    const original: FilterNode[] = [{ not: { dim: 'country', op: 'eq', value: 'SG' } }];
    const draft = draftOfNodes(original);
    const inner = nodeAt(draft, [0]);
    expect(inner?.kind).toBe('group');
    // …and unwraps back to the bare `not` rather than `{not:{all:[leaf]}}`.
    expect(nodes(draft)).toEqual(original);
  });

  it('drops a one-child wrapper, because it asks the same question', () => {
    const root = groupDraft('all', [
      groupDraft('any', [leafDraft({ dim: 'country', op: 'eq', value: 'US' })]),
    ]);
    expect(nodes(root)).toEqual([{ dim: 'country', op: 'eq', value: 'US' }]);
  });
});

describe('refusing an unfinished draft', () => {
  it('names the empty group rather than silently dropping it', () => {
    const root = groupDraft('all', [groupDraft('any')]);
    const result = nodesOf(root);
    expect(result).toEqual({
      error: { path: [0], message: 'a group needs at least one condition' },
    });
  });

  it('names the condition with no value, and where it sits', () => {
    const root = groupDraft('all', [
      groupDraft('any', [
        leafDraft({ dim: 'path', op: 'eq', value: '/ok' }),
        leafDraft({ dim: 'path', op: 'eq', value: '' }),
      ]),
    ]);
    const result = nodesOf(root);
    expect(result).toMatchObject({ error: { path: [0, 1], message: 'a value is required' } });
  });

  it('refuses more than the shared caps allow', () => {
    const wide = groupDraft(
      'all',
      Array.from({ length: MAX_FILTER_NODES + 1 }, (_, i) =>
        leafDraft({ dim: 'country', op: 'eq', value: `C${i}` }),
      ),
    );
    expect(nodesOf(wide)).toMatchObject({ error: { message: /at most 16 top-level/ } });

    const deepGroup = groupDraft(
      'any',
      Array.from({ length: MAX_FILTER_LEAVES + 1 }, (_, i) =>
        leafDraft({ dim: 'country', op: 'eq', value: `C${i}` }),
      ),
    );
    expect(nodesOf(groupDraft('all', [deepGroup]))).toMatchObject({
      error: { message: /at most 32 conditions/ },
    });
  });
});

describe('editing', () => {
  it('inserts, removes, and drops a group left empty by the removal', () => {
    let root = draftOfNodes(EXPRESSION);
    root = insertAt(root, [1], leafDraft({ dim: 'path', op: 'starts', value: '/api' }));
    expect(nodes(root)[1]).toEqual({
      any: [
        { dim: 'path', op: 'contains', value: '/blog' },
        { dim: 'path', op: 'starts', value: '/docs' },
        { dim: 'path', op: 'starts', value: '/api' },
      ],
    });
    root = removeAt(root, [1, 2]);
    root = removeAt(root, [1, 1]);
    root = removeAt(root, [1, 0]);
    // The group went with its last child rather than lingering as an error.
    expect(nodes(root)).toEqual([{ dim: 'country', op: 'neq', value: 'SG' }]);
  });

  it('wraps a condition into a group and unwraps it back', () => {
    const original = draftOfNodes(EXPRESSION);
    const wrapped = wrapAt(original, [0], 'any');
    expect(nodeAt(wrapped, [0])?.kind).toBe('group');
    // A lone child unwraps to the same question it started as.
    expect(nodes(wrapped)).toEqual(EXPRESSION);
    expect(nodes(unwrapAt(wrapped, [0]))).toEqual(EXPRESSION);
  });

  it('unwrapping splices the children into the parent, losing no work', () => {
    const root = draftOfNodes(EXPRESSION);
    expect(nodes(unwrapAt(root, [1]))).toEqual([
      { dim: 'country', op: 'neq', value: 'SG' },
      { dim: 'path', op: 'contains', value: '/blog' },
      { dim: 'path', op: 'starts', value: '/docs' },
    ]);
  });

  it('switches a group between all and any, and negates it', () => {
    let root = draftOfNodes(EXPRESSION);
    root = setGroupOp(root, [1], 'all');
    expect(nodes(root)[1]).toHaveProperty('all');
    root = toggleNegated(root, [1]);
    expect(nodes(root)[1]).toHaveProperty('not');
    expect(nodes(toggleNegated(root, [1]))[1]).toHaveProperty('all');
  });

  it('leaves the root alone when a path names nothing', () => {
    const root = draftOfNodes(EXPRESSION);
    expect(removeAt(root, [9])).toEqual(root);
    expect(wrapAt(root, [9])).toEqual(root);
    expect(unwrapAt(root, [0])).toEqual(root); // [0] is a leaf, not a group
    expect(nodeAt(root, [0, 0])).toBeUndefined();
  });

  it('never mutates the root it was handed', () => {
    const root = draftOfNodes(EXPRESSION);
    const before = JSON.stringify(root);
    insertAt(root, [1], segmentDraft(3));
    removeAt(root, [0]);
    toggleNegated(root, [1]);
    expect(JSON.stringify(root)).toBe(before);
  });
});
