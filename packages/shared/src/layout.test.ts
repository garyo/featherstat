import { describe, expect, it } from 'vitest';
import {
  type Dashboard,
  DashboardSchema,
  MAX_METRICS_PER_QUERY,
  type WidgetSpec,
} from './index.ts';
import {
  DASHBOARD_LAYOUT_VERSION,
  OLDEST_DASHBOARD_LAYOUT_VERSION,
  readStoredDashboard,
  upgradeDashboard,
  upgradeToV2,
  withEngagedSessions,
} from './layout.ts';

/**
 * Exactly what the pre-f47d1e5 editor stored for an avg-engagement tile: no
 * `version` field at all, and a KPI query that never names `engaged_sessions`
 * because the metric did not exist yet. Every assertion below that mentions a
 * "stored" layout starts here.
 */
const PRE_VERSIONING = {
  name: 'Overview',
  site: 1,
  grid: [
    {
      id: 'kpis',
      viz: 'kpi-row',
      w: 12,
      h: 1,
      query: { id: 'kpis', metrics: ['visitors', 'pageviews', 'visits', 'engaged_ms'] },
      options: { tiles: ['visitors', 'avg_engagement'] },
    },
    {
      id: 'series',
      viz: 'timeseries',
      w: 12,
      h: 2,
      query: { id: 'series', metrics: ['engaged_ms'], bucket: 'day' },
    },
  ],
};

function metricsOf(dashboard: Dashboard, index: number): string[] {
  const query = dashboard.grid[index]?.query;
  return query !== undefined && 'metrics' in query ? [...query.metrics] : [];
}

function kpiWidget(metrics: string[]): WidgetSpec {
  return DashboardSchema.shape.grid.element.parse({
    id: 'kpis',
    viz: 'kpi-row',
    w: 12,
    h: 1,
    query: { id: 'kpis', metrics },
  });
}

describe('the version field', () => {
  it('reads a layout with no version as the oldest one, never as invalid', () => {
    const parsed = DashboardSchema.parse(PRE_VERSIONING);
    expect(parsed.version).toBe(OLDEST_DASHBOARD_LAYOUT_VERSION);
  });

  it('reads an unusable version as the oldest one rather than rejecting the row', () => {
    // A hand-edited column, a truncated write, a future field type: none of
    // these may cost the operator their dashboard. Guessing low costs one pass.
    for (const version of ['two', 0, -3, 2.5, null, {}]) {
      const parsed = DashboardSchema.safeParse({ ...PRE_VERSIONING, version });
      expect(parsed.success, JSON.stringify(version)).toBe(true);
      expect(parsed.success && parsed.data.version).toBe(OLDEST_DASHBOARD_LAYOUT_VERSION);
    }
  });

  it('keeps a version newer than this build knows', () => {
    const parsed = DashboardSchema.parse({ ...PRE_VERSIONING, version: 99 });
    expect(parsed.version).toBe(99);
  });
});

describe('upgradeToV2', () => {
  it('gives a KPI query the engaged_sessions its avg-engagement tile divides by', () => {
    const before = DashboardSchema.parse(PRE_VERSIONING);
    expect(metricsOf(before, 0)).not.toContain('engaged_sessions');
    expect(metricsOf(upgradeToV2(before), 0)).toEqual([
      'visitors',
      'pageviews',
      'visits',
      'engaged_ms',
      'engaged_sessions',
    ]);
  });

  it('touches only KPI queries — a timeseries of engaged_ms needs no denominator', () => {
    expect(metricsOf(upgradeToV2(DashboardSchema.parse(PRE_VERSIONING)), 1)).toEqual([
      'engaged_ms',
    ]);
  });

  it('is idempotent, and leaves widgets it has nothing to say about alone', () => {
    const once = upgradeToV2(DashboardSchema.parse(PRE_VERSIONING));
    expect(upgradeToV2(once)).toEqual(once);

    const untouched = [
      kpiWidget(['visitors', 'bounce_rate']), // no engaged_ms
      DashboardSchema.shape.grid.element.parse({ id: 'feed', viz: 'feed', w: 6, h: 2 }), // no query
      DashboardSchema.shape.grid.element.parse({
        id: 'dwell',
        viz: 'dwell',
        w: 6,
        h: 2,
        query: { id: 'dwell', kind: 'dwell' }, // a query with no metrics at all
      }),
    ];
    for (const spec of untouched) expect(withEngagedSessions(spec)).toBe(spec);
  });

  it('never produces a query the schema would then refuse', () => {
    // The metric cap is the one place the rule must decline: an unstorable
    // upgrade would turn a rendering dashboard into an unreadable row.
    const full = [
      'visitors',
      'pageviews',
      'visits',
      'events',
      'outlinks',
      'downloads',
      'engaged_ms',
    ];
    expect(full).toHaveLength(MAX_METRICS_PER_QUERY - 1);
    expect(withEngagedSessions(kpiWidget(full)).query).toMatchObject({
      metrics: [...full, 'engaged_sessions'],
    });

    const atCap = [...full, 'bounce_rate'];
    expect(atCap).toHaveLength(MAX_METRICS_PER_QUERY);
    const spec = kpiWidget(atCap);
    expect(withEngagedSessions(spec)).toBe(spec);
    expect(
      DashboardSchema.safeParse({ ...PRE_VERSIONING, grid: [withEngagedSessions(spec)] }).success,
    ).toBe(true);
  });
});

describe('upgradeDashboard', () => {
  it('applies every step from the layout version up to this build', () => {
    const upgraded = upgradeDashboard(DashboardSchema.parse(PRE_VERSIONING));
    expect(upgraded.version).toBe(DASHBOARD_LAYOUT_VERSION);
    expect(metricsOf(upgraded, 0)).toContain('engaged_sessions');
  });

  it('is idempotent and returns an already-current layout untouched', () => {
    const once = upgradeDashboard(DashboardSchema.parse(PRE_VERSIONING));
    expect(upgradeDashboard(once)).toBe(once);
  });

  it('renders a layout from a newer build as it stands, without stepping or downgrading', () => {
    // A rollback must not blank the dashboard: there is no step to run and none
    // to invent, so the document is answered exactly as stored.
    const newer = DashboardSchema.parse({ ...PRE_VERSIONING, version: 99 });
    const result = upgradeDashboard(newer);
    expect(result).toBe(newer);
    expect(result.version).toBe(99);
    expect(metricsOf(result, 0)).not.toContain('engaged_sessions');
  });
});

describe('readStoredDashboard', () => {
  it('upgrades a row written before the vocabulary changed', () => {
    const layout = readStoredDashboard(JSON.stringify(PRE_VERSIONING));
    expect(layout?.version).toBe(DASHBOARD_LAYOUT_VERSION);
    expect(layout === undefined ? [] : metricsOf(layout, 0)).toContain('engaged_sessions');
  });

  it('reads a row this build cannot execute as absent, never as a cast', () => {
    expect(readStoredDashboard('not json')).toBeUndefined();
    expect(readStoredDashboard('{"broken":true}')).toBeUndefined();
    // Schema-valid but unbatchable: two widgets colliding on one query id.
    const collision = {
      ...PRE_VERSIONING,
      grid: [
        { id: 'a', viz: 'bar-list', w: 6, h: 2, query: { id: 'q', metrics: ['visitors'] } },
        { id: 'b', viz: 'bar-list', w: 6, h: 2, query: { id: 'q', metrics: ['visits'] } },
      ],
    };
    expect(readStoredDashboard(JSON.stringify(collision))).toBeUndefined();
  });
});
