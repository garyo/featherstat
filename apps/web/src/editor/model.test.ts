import { type Dashboard, MAX_WIDGETS_PER_DASHBOARD, type WidgetSpec } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { siteOverview } from '../dashboards/site-overview.ts';
import {
  allowedWidths,
  atWidgetCap,
  buildWidget,
  exportJson,
  nextWidgetId,
  parseDashboardJson,
  removeWidget,
  reorder,
  resizeWidget,
  updateWidget,
} from './model.ts';

const grid = siteOverview.grid;

describe('allowedWidths', () => {
  it('pins full-row frames to 12 and keeps charts at half-width or wider', () => {
    expect(allowedWidths('kpi-row')).toEqual([12]);
    expect(allowedWidths('site-cards')).toEqual([12]);
    expect(allowedWidths('timeseries')).toEqual([6, 12]);
    expect(allowedWidths('heatmap')).toEqual([6, 12]);
    expect(allowedWidths('bar-list')).toEqual([4, 6, 12]);
    expect(allowedWidths('table')).toEqual([4, 6, 12]);
  });
});

describe('grid mutations', () => {
  it('reorders without mutating the input', () => {
    const next = reorder(grid, 0, 2);
    expect(next.map((spec) => spec.id).slice(0, 3)).toEqual(['series', 'pages', 'kpis']);
    expect(grid[0]?.id).toBe('kpis');
    expect(next).toHaveLength(grid.length);
  });

  it('resizes only within the viz allowance', () => {
    expect(resizeWidget(grid, 'pages', 4).find((s) => s.id === 'pages')?.w).toBe(4);
    // kpi-row is a wide frame: any other width is refused.
    expect(resizeWidget(grid, 'kpis', 6).find((s) => s.id === 'kpis')?.w).toBe(12);
  });

  it('removes and replaces by id', () => {
    expect(removeWidget(grid, 'pages').map((s) => s.id)).not.toContain('pages');
    const renamed = grid.find((s) => s.id === 'pages');
    if (renamed === undefined) throw new Error('pages widget expected');
    const next = updateWidget(grid, { ...renamed, title: 'Renamed' });
    expect(next.find((s) => s.id === 'pages')?.title).toBe('Renamed');
    expect(grid.find((s) => s.id === 'pages')?.title).toBe('Top pages');
  });

  it('flags the widget cap', () => {
    const spec = grid[0];
    if (spec === undefined) throw new Error('widget expected');
    const full: Dashboard = {
      ...siteOverview,
      grid: Array.from({ length: MAX_WIDGETS_PER_DASHBOARD }, (_, i) => ({
        ...spec,
        id: `w${i}`,
      })),
    };
    expect(atWidgetCap(full)).toBe(true);
    expect(atWidgetCap(siteOverview)).toBe(false);
  });
});

describe('nextWidgetId', () => {
  it('skips ids already used by widgets or their queries', () => {
    const taken: WidgetSpec[] = [
      { id: 'w1', viz: 'bar-list', w: 6, h: 2, options: {} },
      {
        id: 'x',
        viz: 'bar-list',
        w: 6,
        h: 2,
        options: {},
        query: { id: 'w2', metrics: ['visits'] },
      },
    ];
    expect(nextWidgetId(taken)).toBe('w3');
    expect(nextWidgetId([])).toBe('w1');
  });
});

describe('buildWidget', () => {
  it('builds a bar-list from the picked vocabulary', () => {
    const spec = buildWidget(
      { viz: 'bar-list', title: ' Top pages ', metrics: ['pageviews'], dim: 'path', limit: 5 },
      'w9',
    );
    expect(spec).toMatchObject({
      id: 'w9',
      viz: 'bar-list',
      title: 'Top pages',
      w: 6,
      query: { id: 'w9', metrics: ['pageviews'], dim: 'path', limit: 5 },
    });
  });

  it('gives a kpi-row its tiles and the visits its engagement math needs', () => {
    const spec = buildWidget(
      {
        viz: 'kpi-row',
        title: '',
        metrics: ['visitors', 'bounce_rate'],
        dim: '',
        limit: undefined,
      },
      'w1',
    );
    expect(spec.w).toBe(12);
    expect(spec.title).toBeUndefined();
    expect(spec.options.tiles).toEqual(['visitors', 'bounce_rate']);
    if (spec.query === undefined || 'kind' in spec.query) throw new Error('metric query expected');
    expect(spec.query.metrics).toEqual(['visitors', 'bounce_rate', 'visits']);
  });

  it('pins the fixed-shape vizzes regardless of the picks', () => {
    const heatmap = buildWidget(
      { viz: 'heatmap', title: '', metrics: ['pageviews', 'events'], dim: 'country', limit: 3 },
      'w1',
    );
    if (heatmap.query === undefined || 'kind' in heatmap.query) throw new Error('metric query');
    expect(heatmap.query).toEqual({
      id: 'w1',
      metrics: ['pageviews'],
      dim: 'local_hour',
      dim2: 'weekday',
    });
    const devices = buildWidget(
      { viz: 'devices', title: '', metrics: ['visitors'], dim: '', limit: undefined },
      'w2',
    );
    if (devices.query === undefined || 'kind' in devices.query) throw new Error('metric query');
    expect(devices.query.dim).toBe('device_type');
  });

  it('gives time on page its own query kind, with the schema default depth', () => {
    const spec = buildWidget(
      { viz: 'dwell', title: 'Time on page', metrics: ['pageviews'], dim: 'path', limit: 3 },
      'w1',
    );
    expect(spec).toMatchObject({
      viz: 'dwell',
      w: 6,
      query: { id: 'w1', kind: 'dwell', limit: 10 },
    });
  });

  it('caps timeseries at 4 series and falls back to visitors on an empty pick', () => {
    const series = buildWidget(
      {
        viz: 'timeseries',
        title: '',
        metrics: ['visitors', 'visits', 'pageviews', 'events', 'engaged_ms'],
        dim: '',
        limit: undefined,
      },
      'w1',
    );
    if (series.query === undefined || 'kind' in series.query) throw new Error('metric query');
    expect(series.query.metrics).toHaveLength(4);
    expect(series.query.bucket).toBe('day');

    const fallback = buildWidget(
      { viz: 'bar-list', title: '', metrics: [], dim: 'path', limit: undefined },
      'w2',
    );
    if (fallback.query === undefined || 'kind' in fallback.query) throw new Error('metric query');
    expect(fallback.query.metrics).toEqual(['visitors']);
  });
});

describe('export / import round trip', () => {
  it('round-trips the shipped default', () => {
    const parsed = parseDashboardJson(exportJson(siteOverview));
    expect(parsed).toEqual({ ok: true, dashboard: siteOverview });
  });

  it('reports non-JSON readably', () => {
    const parsed = parseDashboardJson('{not json');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.errors[0]).toMatch(/not JSON/);
  });

  it('reports schema violations as path: message lines', () => {
    const broken = { ...siteOverview, grid: [{ ...siteOverview.grid[0], viz: 'nope' }] };
    const parsed = parseDashboardJson(JSON.stringify(broken));
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.errors.some((line) => line.startsWith('grid.0.viz:'))).toBe(true);
  });

  it('refuses duplicate query ids the schema alone cannot see', () => {
    const dupe = {
      ...siteOverview,
      grid: [siteOverview.grid[2], { ...siteOverview.grid[2], id: 'other' }],
    };
    const parsed = parseDashboardJson(JSON.stringify(dupe));
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.errors[0]).toMatch(/duplicate query id/);
  });

  it('refuses layouts whose derived queries overflow the batch cap', () => {
    // 17 kpi-rows are under the widget cap but derive 34 queries (main + spark).
    const grid = Array.from({ length: 17 }, (_, i) => ({
      id: `w${i}`,
      viz: 'kpi-row',
      w: 12,
      h: 1,
      query: { id: `q${i}`, metrics: ['visitors'] },
      options: {},
    }));
    const parsed = parseDashboardJson(JSON.stringify({ ...siteOverview, grid }));
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.errors[0]).toMatch(/at most 32/);
  });
});
