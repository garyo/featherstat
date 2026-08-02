import {
  type Dashboard,
  EVENT_ONLY_DIMENSIONS,
  EVENT_ONLY_METRICS,
  type Filter,
  filterLeaves,
  isPropDimension,
  type Query,
  type QueryResponse,
  SESSION_ONLY_DIMENSIONS,
  SESSION_ONLY_METRICS,
  type WidgetSpec,
} from '@featherstat/shared';
import type { WidgetData } from '../widgets/types.ts';

/**
 * The view half of the one-fetch rule (CLAUDE.md invariant 1). Collection
 * (`collectBatch`, `widgetQueries`, `hourlyWhenIntraday`) lives in
 * `packages/shared` — the share route assembles the same batch server-side —
 * so this module keeps only what needs the view: routing answers back to
 * widgets, and trimming metrics the active filters make unanswerable.
 */
export { collectBatch, hourlyWhenIntraday } from '@featherstat/shared';

/**
 * The routing half of `collectBatch`: one widget's slice of the batch response,
 * folded to the phases a renderer needs. Shared by the view grid and the editor
 * grid, which answer from the same one response.
 */
export function widgetData(
  spec: WidgetSpec,
  slots: ReadonlyMap<string, Record<string, string>>,
  response: QueryResponse | undefined,
  error: string | undefined,
): WidgetData {
  if (response === undefined) {
    return { phase: error === undefined ? 'loading' : 'error', message: error, results: {} };
  }
  const ids = slots.get(spec.id) ?? {};
  const results: WidgetData['results'] = {};
  for (const [slot, id] of Object.entries(ids)) results[slot] = response.results[id];
  return { phase: 'ready', results };
}

const EVENT_ONLY_DIMS = new Set<string>(EVENT_ONLY_DIMENSIONS);
const SESSION_ONLY_DIMS = new Set<string>(SESSION_ONLY_DIMENSIONS);
const SESSION_METRICS = new Set<string>(SESSION_ONLY_METRICS);
const EVENT_METRICS = new Set<string>(EVENT_ONLY_METRICS);

/**
 * Click-to-filter on a page or event row makes session-level metrics
 * unanswerable, and a filter on a session-only dimension (entry/exit page)
 * symmetrically blocks event-level metrics (the compiler refuses either
 * combination — docs/04 § 3). Rather than send a question that can only error —
 * which would blank the whole KPI row — trim those metrics and let the tiles
 * render "—". A `scope: 'session'` filter blocks nothing, exactly as the
 * compiler reads it. Queries that would lose every metric are left alone:
 * their per-query error names the conflict.
 *
 * The blockers are judged PER QUERY: the view's chips, plus that query's own
 * widget-level filters, plus its (possibly pivoted) grouping dimensions. A
 * widget filtered to one page must lose its bounce column while the widget
 * beside it keeps its own — a view-wide answer here is how filtered KPI tiles
 * used to blank confusingly.
 */
export function withoutBlockedMetrics(
  queries: readonly Query[],
  filters: readonly Filter[],
): Query[] {
  const viewDims = filters
    .filter((filter) => filter.scope !== 'session')
    .map((filter) => filter.dim);
  return queries.map((query) => {
    if ('kind' in query) return query;
    const dims = [...viewDims];
    for (const node of query.filters ?? []) {
      for (const leaf of filterLeaves(node)) {
        if (leaf.scope !== 'session') dims.push(leaf.dim);
      }
    }
    if (query.dim !== undefined) dims.push(query.dim);
    if (query.dim2 !== undefined) dims.push(query.dim2);
    // `prop:` dims live only on event rows, so they block session metrics
    // exactly as the enumerated event-only dimensions do (docs/03 § Props).
    const blocksSessions = dims.some((dim) => EVENT_ONLY_DIMS.has(dim) || isPropDimension(dim));
    const blocksEvents = dims.some((dim) => SESSION_ONLY_DIMS.has(dim));
    if (!blocksSessions && !blocksEvents) return query;
    const kept = query.metrics.filter(
      (metric) =>
        !(blocksSessions && SESSION_METRICS.has(metric)) &&
        !(blocksEvents && EVENT_METRICS.has(metric)),
    );
    if (kept.length === 0 || kept.length === query.metrics.length) return query;
    return { ...query, metrics: kept };
  });
}

/**
 * Whether this dashboard's batch should opt in to `meta.annotations`
 * (docs/04 § 3): exactly when something on it renders the markers. Opt-in per
 * request so an annotation edit only expires the ETags of dashboards that
 * actually show one.
 */
export function wantsAnnotations(dashboard: Dashboard): boolean {
  return dashboard.grid.some((spec) => spec.viz === 'timeseries');
}
