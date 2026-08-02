import {
  DimensionSchema,
  type FilterLeaf,
  type FilterOp,
  type SegmentFilterNode,
  SegmentFilterNodeSchema,
} from '@featherstat/shared';

/**
 * The pure half of the segment/goal filter builder: rows of dim/op/value that
 * AND together, plus the "advanced" JSON escape hatch for trees the rows cannot
 * say (any/not nesting, session scope). The panels own the DOM; every decision
 * that needs no DOM lives here, where it is testable.
 *
 * Round-trip contract: `rowsOf` answers rows exactly when the tree is a flat
 * AND of plain hit-scope leaves — anything richer answers undefined and the
 * panel opens the JSON editor instead, so the builder can never silently
 * flatten a tree it does not understand.
 */

export interface FilterRow {
  dim: string;
  op: FilterOp;
  /** `in` reads this as a comma-separated list; `is_null` ignores it. */
  value: string;
}

/** The ops the row editor offers, with the label a non-compiler reads. */
export const ROW_OPS: ReadonlyArray<{ op: FilterOp; label: string }> = [
  { op: 'eq', label: 'is' },
  { op: 'neq', label: 'is not' },
  { op: 'contains', label: 'contains' },
  { op: 'starts', label: 'starts with' },
  { op: 'in', label: 'is one of' },
  { op: 'glob', label: 'matches glob' },
  { op: 'is_null', label: 'is empty' },
];

export function emptyRow(): FilterRow {
  return { dim: 'path', op: 'eq', value: '' };
}

/** One row as a filter leaf, or an error naming what is wrong with it. */
export function leafOf(row: FilterRow): { leaf: FilterLeaf } | { error: string } {
  const dim = DimensionSchema.safeParse(row.dim.trim());
  if (!dim.success) return { error: `'${row.dim}' is not a dimension` };
  if (row.op === 'is_null') return { leaf: { dim: dim.data, op: 'is_null' } };
  if (row.op === 'in') {
    const values = row.value
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '');
    if (values.length === 0) return { error: "'is one of' needs a comma-separated list" };
    return { leaf: { dim: dim.data, op: 'in', value: values } };
  }
  if (row.value === '') return { error: 'a value is required' };
  return { leaf: { dim: dim.data, op: row.op, value: row.value } };
}

/** All rows as leaves, or the first row-indexed error. */
export function leavesOf(
  rows: readonly FilterRow[],
): { leaves: FilterLeaf[] } | { error: string; row: number } {
  const leaves: FilterLeaf[] = [];
  for (const [index, row] of rows.entries()) {
    const parsed = leafOf(row);
    if ('error' in parsed) return { error: parsed.error, row: index };
    leaves.push(parsed.leaf);
  }
  return { leaves };
}

/** The rows as ONE tree (a segment's shape): a lone leaf stays bare, more AND. */
export function nodeOf(leaves: readonly FilterLeaf[]): SegmentFilterNode {
  const first = leaves[0];
  if (leaves.length === 1 && first !== undefined) return first;
  return { all: [...leaves] };
}

/** A leaf the row editor can hold: hit scope, and a value the inputs can show. */
function rowOfLeaf(node: SegmentFilterNode): FilterRow | undefined {
  if ('all' in node || 'any' in node || 'not' in node) return undefined;
  if (node.scope !== undefined && node.scope !== 'hit') return undefined;
  const value = Array.isArray(node.value) ? node.value.join(', ') : (node.value ?? '');
  return { dim: node.dim, op: node.op, value };
}

/**
 * A stored tree as builder rows, or undefined when only the JSON editor can
 * represent it. Accepts a bare leaf or one `all` of leaves — the exact shapes
 * `nodeOf` produces.
 */
export function rowsOf(node: SegmentFilterNode): FilterRow[] | undefined {
  const nodes = 'all' in node ? node.all : [node];
  if ('any' in node || 'not' in node) return undefined;
  const rows: FilterRow[] = [];
  for (const entry of nodes) {
    const row = rowOfLeaf(entry);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

/** A goal's filter list (implicit AND) as rows — every node must be a plain leaf. */
export function rowsOfNodes(nodes: readonly SegmentFilterNode[]): FilterRow[] | undefined {
  const rows: FilterRow[] = [];
  for (const node of nodes) {
    const row = rowOfLeaf(node);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

/** The advanced editor's parse: JSON, then the shared grammar — fail closed. */
export function parseFilterJson(text: string): { node: SegmentFilterNode } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'not valid JSON' };
  }
  const parsed = SegmentFilterNodeSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'not a filter tree' };
  }
  return { node: parsed.data };
}

/** Goals store an ARRAY of trees; a bare tree is accepted as a list of one. */
export function parseFilterListJson(
  text: string,
): { nodes: SegmentFilterNode[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'not valid JSON' };
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  if (entries.length === 0) return { error: 'a goal needs at least one filter' };
  const nodes: SegmentFilterNode[] = [];
  for (const entry of entries) {
    const parsed = SegmentFilterNodeSchema.safeParse(entry);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? 'not a filter tree' };
    }
    nodes.push(parsed.data);
  }
  return { nodes };
}

/** A one-line reading of a tree for list rows — lossy on purpose. */
export function describeFilter(node: SegmentFilterNode): string {
  if ('all' in node) return node.all.map(describeFilter).join(' and ');
  if ('any' in node) return `(${node.any.map(describeFilter).join(' or ')})`;
  if ('not' in node) return `not (${describeFilter(node.not)})`;
  const label = ROW_OPS.find((entry) => entry.op === node.op)?.label ?? node.op;
  const value = Array.isArray(node.value) ? node.value.join(', ') : (node.value ?? '');
  const scope = node.scope === 'session' ? ' (in session)' : '';
  return node.op === 'is_null'
    ? `${node.dim} ${label}${scope}`
    : `${node.dim} ${label} ${value}${scope}`;
}
