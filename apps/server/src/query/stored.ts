import {
  derivedNameOf,
  type FilterNode,
  filterSegmentRefs,
  goalRefParts,
  isDerivedMetricRef,
  isGoalMetricRef,
  type Query,
  type QueryRequest,
  type SegmentFilterNode,
  SegmentFilterNodeSchema,
} from '@featherstat/shared';
import { type Db, getDerivedMetricByName, getGoal, getSegment } from '../db/index.ts';
import type { GoalDefinitions } from './goals.ts';

/**
 * Stored query-layer objects (docs/04 § 3), resolved on the MAIN thread before
 * a batch is dispatched: segment refs are substituted into the request and
 * derived-metric definitions are collected beside it. Two reasons this happens
 * here and not in the executor:
 *
 * - The ETag hashes the EXPANDED request plus the definitions, so editing a
 *   segment or a derived metric expires every cached answer that used it with
 *   zero extra bookkeeping — `dataVersion` never moves for these tables.
 * - The worker pool then executes pure vocabulary: no worker ever sees a
 *   segment ref, and the one compiler case for `{segment}` is a thrown wiring
 *   bug, not a semantics question.
 *
 * Stored rows are client-authored data: every filter read back is re-parsed
 * with `SegmentFilterNodeSchema` and an unparseable row fails closed to a 400
 * naming the segment (CLAUDE.md: zod at every boundary, JSON columns included).
 */

export type SegmentExpansion =
  | {
      ok: true;
      request: QueryRequest;
      /** Present when `compare` names a segment — resolved here so the ETag
       * covers the tree; the executor re-reads it inside its own snapshot. */
      compareFilter?: SegmentFilterNode;
    }
  | { ok: false; message: string };

export function expandSegments(db: Db, request: QueryRequest): SegmentExpansion {
  const trees = new Map<number, SegmentFilterNode>();
  const resolve = (id: number): SegmentFilterNode | string => {
    const cached = trees.get(id);
    if (cached !== undefined) return cached;
    const tree = segmentFilterOf(db, id);
    if (typeof tree === 'string') return tree;
    trees.set(id, tree);
    return tree;
  };

  const refs = [
    ...(request.filters ?? []).flatMap(filterSegmentRefs),
    ...request.queries.flatMap((query) => (query.filters ?? []).flatMap(filterSegmentRefs)),
  ];
  for (const id of refs) {
    const tree = resolve(id);
    if (typeof tree === 'string') return { ok: false, message: tree };
  }

  let compareFilter: SegmentFilterNode | undefined;
  const compare = request.compare;
  if (typeof compare === 'object' && 'segment' in compare) {
    const tree = resolve(compare.segment);
    if (typeof tree === 'string') return { ok: false, message: tree };
    compareFilter = tree;
  }

  if (refs.length === 0) {
    return compareFilter === undefined
      ? { ok: true, request }
      : { ok: true, request, compareFilter };
  }

  const substituteAll = (filters: readonly FilterNode[] | undefined): FilterNode[] | undefined =>
    filters?.map((node) => substitute(node, trees));
  const expanded: QueryRequest = {
    ...request,
    filters: substituteAll(request.filters),
    queries: request.queries.map(
      (query): Query =>
        query.filters === undefined ? query : { ...query, filters: substituteAll(query.filters) },
    ),
  };
  if (expanded.filters === undefined) delete expanded.filters;
  return compareFilter === undefined
    ? { ok: true, request: expanded }
    : { ok: true, request: expanded, compareFilter };
}

/**
 * One stored segment's filter tree, re-validated — or the message a route
 * should answer with. Unknown and invalid both refuse: segments are named by
 * the same operator's UI, so a bad id is a mistake to surface, not to skip.
 */
export function segmentFilterOf(db: Db, id: number): SegmentFilterNode | string {
  const row = getSegment(db, id);
  if (row === undefined) return `unknown segment ${id}`;
  let raw: unknown;
  try {
    raw = JSON.parse(row.filter);
  } catch {
    raw = undefined;
  }
  const parsed = SegmentFilterNodeSchema.safeParse(raw);
  if (!parsed.success) return `segment ${id} ('${row.name}') is invalid — re-save it`;
  return parsed.data;
}

function substitute(node: FilterNode, trees: ReadonlyMap<number, SegmentFilterNode>): FilterNode {
  if ('all' in node) return { all: node.all.map((child) => substitute(child, trees)) };
  if ('any' in node) return { any: node.any.map((child) => substitute(child, trees)) };
  if ('not' in node) return { not: substitute(node.not, trees) };
  if ('segment' in node) {
    const tree = trees.get(node.segment);
    if (tree === undefined) throw new Error(`segment ${node.segment} vanished mid-expansion`);
    return tree;
  }
  return node;
}

/**
 * Every stored definition the request's `d:` references resolve to, by name.
 * A reference with no stored row is deliberately absent — the executor turns
 * it into a per-query error, so one bad name costs its query, not the batch.
 */
export function resolveDerived(db: Db, request: QueryRequest): Record<string, string> | undefined {
  let derived: Record<string, string> | undefined;
  for (const query of request.queries) {
    if ('kind' in query) continue;
    for (const metric of query.metrics) {
      if (!isDerivedMetricRef(metric)) continue;
      const name = derivedNameOf(metric);
      if (derived?.[name] !== undefined) continue;
      const row = getDerivedMetricByName(db, name);
      if (row === undefined) continue;
      derived ??= {};
      derived[name] = row.expr;
    }
  }
  return derived;
}

/**
 * Every stored goal the request's `goal:` refs resolve to, by decimal id —
 * the same treatment as `resolveDerived`: definitions cross the pool beside
 * the request AND hash into the ETag body, so a goal edit expires every
 * cached answer. Columns ship verbatim; the executor re-parses and fails
 * closed. A ref with no stored row is deliberately absent — the executor
 * turns it into a per-query error, so one bad id costs its query, not the batch.
 */
export function resolveGoals(db: Db, request: QueryRequest): GoalDefinitions | undefined {
  const goals: Record<string, { siteId: number; filters: string; valueExpr: string | null }> = {};
  let found = false;
  for (const query of request.queries) {
    if ('kind' in query) continue;
    for (const metric of query.metrics) {
      if (!isGoalMetricRef(metric)) continue;
      const { id } = goalRefParts(metric);
      if (goals[id] !== undefined) continue;
      const row = getGoal(db, id);
      if (row === undefined) continue;
      goals[id] = { siteId: row.site_id, filters: row.filters, valueExpr: row.value_expr };
      found = true;
    }
  }
  return found ? goals : undefined;
}
