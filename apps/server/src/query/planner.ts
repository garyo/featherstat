import {
  type BaseDimension,
  type FilterLeaf,
  type FilterNode,
  filterLeaves,
  isPropDimension,
  type SiteWindow,
} from '@featherstat/shared';
import { ROLLUP_DIMS } from '../rollup/tables.ts';
import {
  type CompilableMetricQuery,
  invalidLeaf,
  measureOf,
  routeTable,
  tableBlockers,
} from './compiler.ts';

/**
 * The rollup routing decision (docs/03 § Rollups): 'rollup' only when the
 * rollup tables can answer EXACTLY what the raw tables would — same rows, same
 * `measures` header — and 'raw' the moment anything is in doubt. Fail-safe by
 * construction: every rule below falls to raw on the unknown case, so a new
 * dimension, op, or window shape is slow before it is ever wrong. The
 * rollup-vs-raw read equivalence ratchet in `test/replay/` is the referee.
 *
 * Why each rule exists:
 *
 * - **Marginals, not joints.** `rollup_dim_day` / `rollup_sessions_day` store
 *   one dimension per row, so grouping + filtering may reference at most ONE
 *   rolled dimension between them. `site`, `weekday` and the bucket are rollup
 *   keys (or functions of them), and don't count.
 * - **Distinct honesty** (docs/03): per-day distincts are exact but have no
 *   lawful sum across days — uid-stable visitor ids recur — so `visitors` (and
 *   the events-side `visits`) route to rollups only at day buckets or over a
 *   single-day window, and only where no filter can merge two dim rows into
 *   one group.
 * - **Hour grain is undimensioned**: `rollup_traffic_hour` carries no dim rows
 *   and no distincts, so hour shapes roll up only for additive event metrics
 *   with no rolled dimension in play.
 * - **Rolling windows go raw**: a `fromTs`/`toTs` refinement cuts inside local
 *   dates; mapping those instants onto rollup keys is DST-fraught, and the 24h
 *   preset is cheap on raw anyway (correctness first, docs/03).
 * - **The bounce guard**: `bounced` bakes in `ENGAGEMENT_THRESHOLD_MS`
 *   (invariant 5). While `rollup_meta` says the stored history needs a rebuild,
 *   session metrics refuse the rollup route rather than answer from stale rows.
 */

export type QueryRoute = 'rollup' | 'raw';

export interface PlanContext {
  /** `rollupNeedsRebuild(db)`: the session side's bounce columns are stale. */
  sessionRollupsStale?: boolean;
}

export function planMetricRoute(
  query: CompilableMetricQuery,
  globalFilters: readonly FilterNode[],
  windows: readonly SiteWindow[],
  context: PlanContext = {},
): QueryRoute {
  if (query.dim2 !== undefined) return 'raw';
  if (windows.length === 0) return 'raw';
  if (windows.some((window) => window.fromTs !== undefined)) return 'raw';

  const filters = [...globalFilters, ...(query.filters ?? [])];
  // An unexpanded segment ref or a malformed leaf: the raw path owns the
  // refusal (or the wiring error), so both stores report identically.
  if (filters.some(hasSegmentRef)) return 'raw';
  const leaves = filters.flatMap(filterLeaves);
  if (invalidLeaf(leaves) !== undefined) return 'raw';
  if (leaves.some((leaf) => leaf.scope === 'session')) return 'raw';

  // Every referenced dimension must be rolled or derivable from rollup keys,
  // and at most one may be rolled. `prop:` dims are never rolled — raw only —
  // and any other string outside ROLLUP_DIMS falls through to raw the same way.
  const rolled = new Set<BaseDimension>();
  for (const dim of [query.dim, ...leaves.map((leaf) => leaf.dim)]) {
    if (dim === undefined) continue;
    if (isPropDimension(dim)) return 'raw';
    const entry = ROLLUP_DIMS[dim] as (typeof ROLLUP_DIMS)[BaseDimension] | undefined;
    if (entry === undefined || entry === 'raw-only') return 'raw';
    if (entry !== 'derived') rolled.add(dim);
  }
  if (rolled.size > 1) return 'raw';
  const rolledDim: BaseDimension | undefined = [...rolled][0];

  // `local_hour` exists only on rollup_traffic_hour, which has no dim rows:
  // an hour bucket or an hour dimension excludes every rolled dimension.
  const hourShape =
    query.bucket === 'hour' || query.dim === 'local_hour' || leaves.some(isLocalHourLeaf);
  if (hourShape && rolledDim !== undefined) return 'raw';

  // Σ(per-day distinct) is only lawful where every group covers one day…
  const singleDay = windows.every((window) => window.from === window.to);
  const distinctOk = query.bucket === 'day' || (query.bucket === undefined && singleDay);

  const blockers = tableBlockers(query, filters);
  for (const metric of new Set(query.metrics)) {
    const table = routeTable(metric, blockers);
    if (table === null) return 'raw'; // the raw compiler owns the honest refusal
    if (table === 'sessions') {
      if (context.sessionRollupsStale === true) return 'raw';
      if (rolledDim !== undefined && !sessionSideRolled(rolledDim)) return 'raw';
      continue;
    }
    if (measureOf(metric, 'events').aggregate === 'distinct') {
      if (hourShape || !distinctOk) return 'raw';
      // …and where no filter can merge two dim rows into one group. Grouping
      // by the rolled dim keeps every group a single row; without grouping,
      // only plain top-level equality leaves are guaranteed row-preserving
      // (`any`/`not` trees and multi-value ops can span rows the same visitor
      // touched twice).
      if (rolledDim !== undefined && query.dim !== rolledDim) {
        if (!filters.every(isLeaf)) return 'raw';
        for (const leaf of leaves) {
          if (leaf.dim === rolledDim && leaf.op !== 'eq' && leaf.op !== 'is_null') return 'raw';
        }
      }
    } else if (rolledDim !== undefined && !eventSideRolled(rolledDim)) {
      return 'raw';
    }
  }
  return 'rollup';
}

function hasSegmentRef(node: FilterNode): boolean {
  if ('all' in node) return node.all.some(hasSegmentRef);
  if ('any' in node) return node.any.some(hasSegmentRef);
  if ('not' in node) return hasSegmentRef(node.not);
  return 'segment' in node;
}

function isLeaf(node: FilterNode): node is FilterLeaf {
  return 'dim' in node;
}

function isLocalHourLeaf(leaf: FilterLeaf): boolean {
  return leaf.dim === 'local_hour' && leaf.scope !== 'session';
}

function eventSideRolled(dim: BaseDimension): boolean {
  const entry = ROLLUP_DIMS[dim];
  return typeof entry === 'object' && (entry.tables === 'events' || entry.tables === 'both');
}

function sessionSideRolled(dim: BaseDimension): boolean {
  const entry = ROLLUP_DIMS[dim];
  return typeof entry === 'object' && (entry.tables === 'sessions' || entry.tables === 'both');
}
