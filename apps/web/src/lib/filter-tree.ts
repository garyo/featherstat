import {
  type FilterLeaf,
  type FilterNode,
  type FilterScope,
  filterDepth,
  filterLeaves,
  MAX_FILTER_DEPTH,
  MAX_FILTER_LEAVES,
  MAX_FILTER_NODES,
} from '@featherstat/shared';
import { type FilterRow, leafOf } from './filter-builder.ts';

/**
 * The editable half of the filter grammar (docs/05 § Filters). The wire shape
 * (`FilterNode`) is always valid; a tree being *edited* is not — a condition
 * with an empty value, a group with nothing in it yet. So the editor holds a
 * DRAFT, and `nodesOf` is the one place a draft becomes something the query API
 * would accept. Exactly the round-trip discipline `rowsOf` already has for the
 * flat editor: convert on demand, refuse rather than silently drop.
 *
 * Two deliberate differences from the wire shape:
 *
 * - **`not` is a flag on a group, not a node.** Readers think "NOT (a or b)",
 *   and an editor that made `not` its own nesting level would show a wrapper
 *   with one child for every negation.
 * - **Every node carries an `id`.** Svelte keys its `{#each}` on it, so editing
 *   a sibling cannot steal focus from the input being typed into.
 */

export type DraftNode =
  | { kind: 'leaf'; id: number; row: FilterRow; scope: FilterScope }
  | { kind: 'segment'; id: number; segment: number }
  | { kind: 'group'; id: number; op: 'all' | 'any'; negated: boolean; children: DraftNode[] };

export type DraftGroup = Extract<DraftNode, { kind: 'group' }>;

/** Where a node sits: child indices from the root, outermost first. */
export type DraftPath = readonly number[];

let nextId = 0;
function mint(): number {
  nextId += 1;
  return nextId;
}

export function leafDraft(row: FilterRow, scope: FilterScope = 'hit'): DraftNode {
  return { kind: 'leaf', id: mint(), row, scope };
}

export function segmentDraft(segment: number): DraftNode {
  return { kind: 'segment', id: mint(), segment };
}

export function groupDraft(
  op: 'all' | 'any' = 'all',
  children: DraftNode[] = [],
  negated = false,
): DraftGroup {
  return { kind: 'group', id: mint(), op, negated, children };
}

// ---------------------------------------------------------------------------
// wire → draft → wire
// ---------------------------------------------------------------------------

/** The view's filter list is an implicit AND, so its draft is an `all` root. */
export function draftOfNodes(nodes: readonly FilterNode[]): DraftGroup {
  return groupDraft('all', nodes.map(draftOfNode));
}

export function draftOfNode(node: FilterNode): DraftNode {
  if ('not' in node) {
    const inner = draftOfNode(node.not);
    // A negated group negates in place; anything else gains the group that
    // carries the flag, which is the only shape the editor can show a NOT on.
    if (inner.kind === 'group' && !inner.negated) return { ...inner, negated: true };
    return groupDraft('all', [inner], true);
  }
  if ('all' in node) return groupDraft('all', node.all.map(draftOfNode));
  if ('any' in node) return groupDraft('any', node.any.map(draftOfNode));
  if ('segment' in node) return segmentDraft(node.segment);
  const value = Array.isArray(node.value) ? node.value.join(', ') : (node.value ?? '');
  return leafDraft({ dim: node.dim, op: node.op, value }, node.scope ?? 'hit');
}

/** The first thing wrong with the draft, in the words the editor shows. */
export interface DraftError {
  path: DraftPath;
  message: string;
}

/**
 * The root's children as wire nodes — the view's filter list — or the first
 * error. Empty groups are an error rather than a silent drop: a group the user
 * opened and left empty is unfinished work, not an empty intention.
 */
export function nodesOf(root: DraftGroup): { nodes: FilterNode[] } | { error: DraftError } {
  const nodes: FilterNode[] = [];
  for (const [index, child] of root.children.entries()) {
    const converted = nodeOf(child, [index]);
    if ('error' in converted) return converted;
    nodes.push(converted.node);
  }
  if (nodes.length > MAX_FILTER_NODES) {
    return { error: { path: [], message: `at most ${MAX_FILTER_NODES} top-level conditions` } };
  }
  const leaves = nodes.reduce((total, node) => total + filterLeaves(node).length, 0);
  if (leaves > MAX_FILTER_LEAVES) {
    return { error: { path: [], message: `at most ${MAX_FILTER_LEAVES} conditions in total` } };
  }
  for (const [index, node] of nodes.entries()) {
    if (filterDepth(node) > MAX_FILTER_DEPTH) {
      return { error: { path: [index], message: `groups nest at most ${MAX_FILTER_DEPTH} deep` } };
    }
  }
  return { nodes };
}

function nodeOf(draft: DraftNode, path: DraftPath): { node: FilterNode } | { error: DraftError } {
  if (draft.kind === 'segment') return { node: { segment: draft.segment } };
  if (draft.kind === 'leaf') {
    const parsed = leafOf(draft.row);
    if ('error' in parsed) return { error: { path, message: parsed.error } };
    const leaf: FilterLeaf =
      draft.scope === 'session' ? { ...parsed.leaf, scope: 'session' } : parsed.leaf;
    return { node: leaf };
  }
  if (draft.children.length === 0) {
    return { error: { path, message: 'a group needs at least one condition' } };
  }
  const children: FilterNode[] = [];
  for (const [index, child] of draft.children.entries()) {
    const converted = nodeOf(child, [...path, index]);
    if ('error' in converted) return converted;
    children.push(converted.node);
  }
  // One child needs no wrapper — `{all:[x]}` and `x` ask the same question, and
  // the bare one keeps the URL (and the chip) shorter.
  const first = children[0] as FilterNode;
  const inner: FilterNode =
    children.length === 1 ? first : draft.op === 'all' ? { all: children } : { any: children };
  return { node: draft.negated ? { not: inner } : inner };
}

// ---------------------------------------------------------------------------
// editing — every operation returns a new root, never mutates
// ---------------------------------------------------------------------------

export function nodeAt(root: DraftNode, path: DraftPath): DraftNode | undefined {
  let node: DraftNode | undefined = root;
  for (const index of path) {
    if (node?.kind !== 'group') return undefined;
    node = node.children[index];
  }
  return node;
}

/** `replace(root, path, undefined)` removes; a group emptied by it goes too. */
export function replaceAt(
  root: DraftGroup,
  path: DraftPath,
  next: DraftNode | undefined,
): DraftGroup {
  const replaced = replaceIn(root, path, next);
  // The root is the implicit AND — it may be empty, and it never disappears.
  return replaced?.kind === 'group' ? replaced : groupDraft('all');
}

function replaceIn(
  node: DraftNode,
  path: DraftPath,
  next: DraftNode | undefined,
): DraftNode | undefined {
  if (path.length === 0) return next;
  if (node.kind !== 'group') return node;
  const [index, ...rest] = path;
  const child = node.children[index as number];
  if (child === undefined) return node;
  const updated = replaceIn(child, rest, next);
  const children = [...node.children];
  if (updated !== undefined) {
    children[index as number] = updated;
    return { ...node, children };
  }
  children.splice(index as number, 1);
  // Removing the last condition removes the group holding it, all the way up:
  // an empty group left behind is only an error message blocking Apply. A group
  // the user opened with "+ group" is untouched by this — nothing was removed.
  return children.length === 0 ? undefined : { ...node, children };
}

export function insertAt(root: DraftGroup, path: DraftPath, child: DraftNode): DraftGroup {
  const target = nodeAt(root, path);
  if (target?.kind !== 'group') return root;
  return replaceAt(root, path, { ...target, children: [...target.children, child] });
}

export function removeAt(root: DraftGroup, path: DraftPath): DraftGroup {
  return replaceAt(root, path, undefined);
}

/** Wrap a node in a new group — "group this condition with another". */
export function wrapAt(root: DraftGroup, path: DraftPath, op: 'all' | 'any' = 'any'): DraftGroup {
  const target = nodeAt(root, path);
  if (target === undefined || path.length === 0) return root;
  return replaceAt(root, path, groupDraft(op, [target]));
}

/** Splice a group's children into its parent, losing the group but not the work. */
export function unwrapAt(root: DraftGroup, path: DraftPath): DraftGroup {
  const target = nodeAt(root, path);
  if (target?.kind !== 'group' || path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1] as number;
  const parent = nodeAt(root, parentPath);
  if (parent?.kind !== 'group') return root;
  const children = [...parent.children];
  children.splice(index, 1, ...target.children);
  return replaceAt(root, parentPath, { ...parent, children });
}

export function setGroupOp(root: DraftGroup, path: DraftPath, op: 'all' | 'any'): DraftGroup {
  const target = nodeAt(root, path);
  if (target?.kind !== 'group') return root;
  return replaceAt(root, path, { ...target, op });
}

export function toggleNegated(root: DraftGroup, path: DraftPath): DraftGroup {
  const target = nodeAt(root, path);
  if (target?.kind !== 'group') return root;
  return replaceAt(root, path, { ...target, negated: !target.negated });
}

export function setLeaf(
  root: DraftGroup,
  path: DraftPath,
  row: FilterRow,
  scope: FilterScope,
): DraftGroup {
  const target = nodeAt(root, path);
  if (target?.kind !== 'leaf') return root;
  return replaceAt(root, path, { ...target, row, scope });
}
