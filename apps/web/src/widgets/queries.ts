import type { Query, WidgetSpec } from '@analytics/shared';

/**
 * The queries a widget contributes to its view's batch, keyed by result slot.
 * Widgets declare; the view collects them into ONE `/api/query` request
 * (CLAUDE.md invariant 1) and hands each widget its slice back by these keys.
 * Derived queries take ids namespaced under the widget's own query id.
 */

const SPARK_SUFFIX = '~spark';

/** A KPI sparkline companion, recognizable anywhere the batch is reshaped. */
export function isSparkCompanion(id: string): boolean {
  return id.endsWith(SPARK_SUFFIX);
}

export function widgetQueries(spec: WidgetSpec): Record<string, Query> {
  if (spec.query === undefined) return {};
  const queries: Record<string, Query> = { main: spec.query };
  // KPI tiles carry a 12-point sparkline: a bucketed companion of the same metrics.
  if (spec.viz === 'kpi-row' && !('kind' in spec.query)) {
    queries.spark = { ...spec.query, id: `${spec.query.id}${SPARK_SUFFIX}`, bucket: 'day' };
  }
  return queries;
}
