import {
  type Dashboard,
  DashboardSchema,
  MAX_METRICS_PER_QUERY,
  type Metric,
  type WidgetSpec,
} from './index.ts';
import { dashboardBatchIssue } from './widgets.ts';

/**
 * Carrying a stored layout across a vocabulary change (docs/05 § Layout versions).
 *
 * A saved dashboard is a client-authored query plan the server executes later —
 * on the detail route and behind a public share link — so the vocabulary it
 * names can move under it. Every layout therefore says which vocabulary it was
 * written against, and is carried forward ON READ (`readStoredDashboard`), never
 * rewritten in place.
 *
 * Changing the vocabulary means APPENDING one step below and nothing else. Never
 * edit or reorder a landed step: rows written against it still exist, and the
 * step is the only record of what those rows meant.
 */

/** No `version` field means the layout predates versioning — the oldest there is. */
export const OLDEST_DASHBOARD_LAYOUT_VERSION = 1;

/**
 * `metric` added to a KPI query that names `engaged_ms` and lacks it. Both
 * engagement steps are this rule with a different name, so the shape of the
 * condition — which widget, which trigger, which cap — is written once.
 *
 * An upgrade must never produce a document DashboardSchema would then refuse,
 * so a query already at the metric cap keeps the plan it has.
 */
function withEngagementMetric(spec: WidgetSpec, metric: Metric): WidgetSpec {
  const query = spec.query;
  if (spec.viz !== 'kpi-row' || query === undefined || 'kind' in query) return spec;
  if (!query.metrics.includes('engaged_ms') || query.metrics.includes(metric)) return spec;
  if (query.metrics.length >= MAX_METRICS_PER_QUERY) return spec;
  return { ...spec, query: { ...query, metrics: [...query.metrics, metric] } };
}

/**
 * The `engaged_ms` ⇒ `engaged_sessions` rule over one widget. The v1 → v2 step
 * maps it across a stored grid.
 */
export function withEngagedSessions(spec: WidgetSpec): WidgetSpec {
  return withEngagementMetric(spec, 'engaged_sessions');
}

/** The `engaged_ms` ⇒ `avg_engagement` rule over one widget (the v2 → v3 step). */
export function withAvgEngagement(spec: WidgetSpec): WidgetSpec {
  return withEngagementMetric(spec, 'avg_engagement');
}

/**
 * Every metric a freshly built KPI widget needs beyond the ones its author
 * picked. The add-widget factory builds through this, so a new widget is born
 * at the current vocabulary instead of being upgraded into it on first read.
 */
export function withKpiCompanions(spec: WidgetSpec): WidgetSpec {
  return withAvgEngagement(withEngagedSessions(spec));
}

/**
 * v1 → v2 (commit f47d1e5): the avg-engagement tile divides engaged time by the
 * visits that could be MEASURED, so a KPI query naming `engaged_ms` must name
 * `engaged_sessions` too. Layouts saved before that metric existed name only
 * `engaged_ms`, and their tile reads '—' with nothing logged anywhere.
 */
export function upgradeToV2(dashboard: Dashboard): Dashboard {
  return { ...dashboard, grid: dashboard.grid.map(withEngagedSessions) };
}

/**
 * v2 → v3 (P2, populations and measures): the avg-engagement tile stopped doing
 * its own division and now reads the server's `avg_engagement` metric, which
 * declares its population (`measured_sessions`) and its components. A KPI query
 * naming `engaged_ms` must therefore name `avg_engagement` too, or its tile
 * reads '—' with nothing logged anywhere — the same failure v1 → v2 answered.
 */
export function upgradeToV3(dashboard: Dashboard): Dashboard {
  return { ...dashboard, grid: dashboard.grid.map(withAvgEngagement) };
}

/** Append only. Index i carries a v(i+1) layout to v(i+2). */
const STEPS: readonly ((dashboard: Dashboard) => Dashboard)[] = [upgradeToV2, upgradeToV3];

/** The layout version this build writes: the oldest, plus one per landed step. */
export const DASHBOARD_LAYOUT_VERSION = OLDEST_DASHBOARD_LAYOUT_VERSION + STEPS.length;

/**
 * A layout at the vocabulary this build speaks, from a layout at any older one.
 * Idempotent, and pure — the caller decides what to do with the result.
 */
export function upgradeDashboard(dashboard: Dashboard): Dashboard {
  // A version we have never heard of was written by a NEWER build: there is no
  // step to run and none to invent, so it renders as it stands. Refusing it
  // would blank a dashboard for the length of a rollback.
  if (dashboard.version >= DASHBOARD_LAYOUT_VERSION) return dashboard;
  let next = dashboard;
  const from = Math.max(0, dashboard.version - OLDEST_DASHBOARD_LAYOUT_VERSION);
  for (const step of STEPS.slice(from)) next = step(next);
  return { ...next, version: DASHBOARD_LAYOUT_VERSION };
}

/**
 * The one way the `dashboards.layout` column becomes a Dashboard: parse, carry
 * forward, then confirm the result is still something a view could actually
 * fetch. Every reader of a stored layout goes through here — the detail route
 * and the public share route — so the next vocabulary change reaches all of them
 * at once, which is exactly what `engaged_sessions` did not.
 *
 * Undefined means the row is unreadable; the caller decides how loudly.
 */
export function readStoredDashboard(json: string): Dashboard | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = DashboardSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const upgraded = upgradeDashboard(parsed.data);
  return dashboardBatchIssue(upgraded) === undefined ? upgraded : undefined;
}
