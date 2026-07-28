import type { Dashboard, MetricQuery, Query, Range, WidgetSpec } from './index.ts';
import { MAX_QUERIES_PER_BATCH } from './index.ts';

/**
 * The queries a widget contributes to its view's batch, keyed by result slot.
 * Widgets declare; the view collects them into ONE `/api/query` request
 * (CLAUDE.md invariant 1) and hands each widget its slice back by these keys.
 * Derived queries take ids namespaced under the widget's own query id.
 *
 * This derivation is part of the cross-package contract: the share route
 * (`GET /share/:token`) assembles the SAME batch server-side, so a shared
 * dashboard answers exactly what the in-app view would ask.
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

function withMergeHeadroom(query: Query): Query {
  if ('kind' in query || query.dim !== 'path' || query.limit === undefined) return query;
  return { ...query, limit: Math.min(1000, query.limit * PATH_MERGE_HEADROOM) };
}

/**
 * The per-site page-trend companions of the all-sites card grid, keyed by
 * `pages~<siteId>`. Site ids come from the widget's options — the dashboard is
 * built against the live `/api/sites` directory. Deliberately unlimited: a
 * LIMIT over `path × day` rows would truncate whole days, not whole pages;
 * the site's own path count bounds the result.
 */
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

/**
 * The collection half of the one-fetch rule (CLAUDE.md invariant 1): widgets
 * declare queries, the view gathers them here into the body of its single
 * `/api/query` request and routes each answer back by widget id + slot.
 */
export interface CollectedBatch {
  /** Every widget's queries in grid order — the whole batch. */
  queries: Query[];
  /** widget id → result slot → query id within the batch. */
  slots: Map<string, Record<string, string>>;
}

export function collectBatch(dashboard: Dashboard): CollectedBatch {
  const queries: Query[] = [];
  const slots = new Map<string, Record<string, string>>();
  const seen = new Set<string>();
  for (const spec of dashboard.grid) {
    const ids: Record<string, string> = {};
    for (const [slot, query] of Object.entries(widgetQueries(spec))) {
      if (seen.has(query.id)) {
        throw new Error(`dashboard '${dashboard.name}': duplicate query id '${query.id}'`);
      }
      seen.add(query.id);
      queries.push(query);
      ids[slot] = query.id;
    }
    slots.set(spec.id, ids);
  }
  return { queries, slots };
}

/**
 * Why this dashboard cannot batch, or undefined when it can. `DashboardSchema`
 * caps widgets but cannot see the DERIVED queries (sparklines, browsers,
 * per-site pages), so a schema-valid layout can still collide query ids or
 * overflow `MAX_QUERIES_PER_BATCH`. Every writer (editor save, import, the
 * admin PUT/POST) and the share route's re-validation check here, so a stored
 * layout is always one the view can actually fetch.
 */
export function dashboardBatchIssue(dashboard: Dashboard): string | undefined {
  let batch: CollectedBatch;
  try {
    batch = collectBatch(dashboard);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  if (batch.queries.length > MAX_QUERIES_PER_BATCH) {
    return (
      `dashboard '${dashboard.name}': its widgets need ${batch.queries.length} queries, ` +
      `but one batch carries at most ${MAX_QUERIES_PER_BATCH} — remove widgets`
    );
  }
  return undefined;
}

export type RangePreset = Extract<Range, { preset: string }>['preset'];

/**
 * `today` resolves to a single local day, where day buckets collapse to one
 * point — serve hours instead. Bucketing stays a widget concern for every
 * other preset.
 *
 * KPI spark companions are exempt: they mix session-level metrics (engaged_ms,
 * bounce_rate) that the vocabulary cannot bucket by hour, so rewriting them
 * turns the whole companion into a compile error. They keep day buckets and
 * collapse to a single point, which KpiRow renders sparkless.
 */
export function hourlyWhenToday(queries: readonly Query[], range: RangePreset): Query[] {
  if (range !== 'today') return [...queries];
  return queries.map((query) =>
    'kind' in query || query.bucket !== 'day' || isSparkCompanion(query.id)
      ? query
      : { ...query, bucket: 'hour' },
  );
}
