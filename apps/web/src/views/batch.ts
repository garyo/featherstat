import {
  EVENT_ONLY_DIMENSIONS,
  type Filter,
  type Query,
  type QueryResponse,
  SESSION_ONLY_METRICS,
  type WidgetSpec,
} from '@featherstat/shared';
import type { WidgetData } from '../widgets/types.ts';

/**
 * The view half of the one-fetch rule (CLAUDE.md invariant 1). Collection
 * (`collectBatch`, `widgetQueries`, `hourlyWhenToday`) lives in
 * `packages/shared` — the share route assembles the same batch server-side —
 * so this module keeps only what needs the view: routing answers back to
 * widgets, and trimming metrics the active filters make unanswerable.
 */
export { collectBatch, hourlyWhenToday } from '@featherstat/shared';

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

const EVENT_ONLY = new Set<string>(EVENT_ONLY_DIMENSIONS);
const SESSION_ONLY = new Set<string>(SESSION_ONLY_METRICS);

/**
 * Click-to-filter on a page or event row makes session-level metrics
 * unanswerable (the compiler refuses the combination — docs/04 § 3). Rather
 * than send a question that can only error — which would blank the whole KPI
 * row — trim those metrics and let the tiles render "—". Queries that would
 * lose every metric are left alone: their per-query error names the conflict.
 */
export function withoutBlockedMetrics(
  queries: readonly Query[],
  filters: readonly Filter[],
): Query[] {
  if (!filters.some((filter) => EVENT_ONLY.has(filter.dim))) return [...queries];
  return queries.map((query) => {
    if ('kind' in query) return query;
    const kept = query.metrics.filter((metric) => !SESSION_ONLY.has(metric));
    if (kept.length === 0 || kept.length === query.metrics.length) return query;
    return { ...query, metrics: kept };
  });
}
