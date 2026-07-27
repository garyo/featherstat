import type { MetricQuery, Query, WidgetSpec } from '@analytics/shared';

/**
 * The queries a widget contributes to its view's batch, keyed by result slot.
 * Widgets declare; the view collects them into ONE `/api/query` request
 * (CLAUDE.md invariant 1) and hands each widget its slice back by these keys.
 * Derived queries take ids namespaced under the widget's own query id.
 */

const SPARK_SUFFIX = '~spark';
const BROWSERS_SUFFIX = '~browsers';
const PAGES_INFIX = '~pages~';

/** Browser rows shown under the device bar's divider (mockup). */
const BROWSERS_LIMIT = 6;

/** A KPI sparkline companion, recognizable anywhere the batch is reshaped. */
export function isSparkCompanion(id: string): boolean {
  return id.endsWith(SPARK_SUFFIX);
}

/** The slot key a site-cards widget reads one site's top-pages result from. */
export function sitePagesSlot(siteId: number): string {
  return `pages~${siteId}`;
}

/**
 * Path rankings merge campaign variants (`/x?utm=…` → `/x`) client-side, so a
 * server LIMIT equal to the display count starves the list after the merge.
 * Over-fetch by this factor; BarList trims back to the spec's limit.
 */
export const PATH_MERGE_HEADROOM = 3;

export function widgetQueries(spec: WidgetSpec): Record<string, Query> {
  if (spec.query === undefined) return {};
  const queries: Record<string, Query> = { main: withMergeHeadroom(spec.query) };
  if ('kind' in spec.query) return queries;
  // KPI tiles carry a 12-point sparkline: a bucketed companion of the same metrics.
  if (spec.viz === 'kpi-row') {
    queries.spark = { ...spec.query, id: `${spec.query.id}${SPARK_SUFFIX}`, bucket: 'day' };
  }
  // The devices card is one widget, two breakdowns: device bar + browsers list.
  if (spec.viz === 'devices') {
    queries.browsers = {
      id: `${spec.query.id}${BROWSERS_SUFFIX}`,
      metrics: spec.query.metrics,
      dim: 'browser',
      filters: spec.query.filters,
      limit: BROWSERS_LIMIT,
    };
  }
  // R20: one top-pages trend query per site rides the SAME all-sites batch.
  if (spec.viz === 'site-cards') {
    for (const [slot, query] of Object.entries(sitePagesQueries(spec.query, spec.options))) {
      queries[slot] = query;
    }
  }
  return queries;
}

/**
 * The per-site page-trend companions of the all-sites card grid, keyed by
 * `pages~<siteId>`. Site ids come from the widget's options — the dashboard is
 * built against the live `/api/sites` directory. Deliberately unlimited: a
 * LIMIT over `path × day` rows would truncate whole days, not whole pages;
 * the site's own path count bounds the result.
 */
function withMergeHeadroom(query: Query): Query {
  if ('kind' in query || query.dim !== 'path' || query.limit === undefined) return query;
  return { ...query, limit: Math.min(1000, query.limit * PATH_MERGE_HEADROOM) };
}

export function sitePagesQueries(
  base: MetricQuery,
  options: Record<string, unknown>,
): Record<string, MetricQuery> {
  const queries: Record<string, MetricQuery> = {};
  for (const siteId of siteIdsOf(options)) {
    queries[sitePagesSlot(siteId)] = {
      id: `${base.id}${PAGES_INFIX}${siteId}`,
      metrics: ['pageviews'],
      dim: 'path',
      bucket: 'day',
      filters: [{ dim: 'site', op: 'eq', value: String(siteId) }],
    };
  }
  return queries;
}

function siteIdsOf(options: Record<string, unknown>): number[] {
  const raw = options.siteIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0);
}
