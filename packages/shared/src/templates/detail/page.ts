import type { Dashboard } from '../../index.ts';
import { buildDashboard } from '../build.ts';

/**
 * One page's detail view (docs/05 § Detail views). The entity is baked into
 * each widget's own query — a hit filter where the question is about hits on
 * the page, a `scope: 'session'` filter where it is about the sessions that
 * contained it, and the entry/exit dimensions for the boundary KPIs — because
 * no single request-level filter can say all three honestly at once. The view
 * shows the binding as a locked chip; its removable chips ride the request's
 * `filters` on top.
 */
export function pageDetail(site: number, path: string): Dashboard {
  const onPage = [{ dim: 'path', op: 'eq', value: path }];
  const inSession = [{ dim: 'path', op: 'eq', value: path, scope: 'session' }];
  return buildDashboard({
    name: 'Page detail',
    site,
    grid: [
      {
        id: 'kpis',
        viz: 'kpi-row',
        w: 12,
        h: 1,
        query: { id: 'kpis', metrics: ['pageviews', 'visitors', 'visits'], filters: onPage },
        options: { tiles: ['pageviews', 'visitors', 'visits'] },
      },
      {
        id: 'entries',
        viz: 'kpi-row',
        title: 'Sessions entering here',
        w: 6,
        h: 1,
        query: {
          id: 'entries',
          metrics: ['visits'],
          filters: [{ dim: 'entry_path', op: 'eq', value: path }],
        },
        options: { tiles: ['visits'] },
      },
      {
        id: 'exits',
        viz: 'kpi-row',
        title: 'Sessions exiting here',
        w: 6,
        h: 1,
        query: {
          id: 'exits',
          metrics: ['visits'],
          filters: [{ dim: 'exit_path', op: 'eq', value: path }],
        },
        options: { tiles: ['visits'] },
      },
      {
        id: 'trend',
        viz: 'timeseries',
        title: 'Pageviews & visitors',
        w: 12,
        h: 2,
        query: {
          id: 'trend',
          metrics: ['pageviews', 'visitors'],
          bucket: 'day',
          filters: onPage,
        },
      },
      {
        id: 'refs',
        viz: 'bar-list',
        title: 'Referrers of its sessions',
        w: 6,
        h: 2,
        query: { id: 'refs', metrics: ['visits'], dim: 'ref_domain', filters: inSession, limit: 8 },
        options: { nullLabel: 'Direct' },
      },
      {
        id: 'dwell',
        viz: 'dwell',
        title: 'Time on this page',
        w: 6,
        h: 2,
        query: { id: 'dwell', kind: 'dwell', path, limit: 1 },
      },
      {
        id: 'prev',
        viz: 'bar-list',
        // "Before/After", not "pages": a step is a MOVE, and an event row
        // ('event: scroll · read') is an honest answer here (STEP_LABEL).
        title: 'Before this page',
        w: 6,
        h: 2,
        query: { id: 'prev', kind: 'adjacency', path, direction: 'in', limit: 8 },
      },
      {
        id: 'next',
        viz: 'bar-list',
        title: 'After this page',
        w: 6,
        h: 2,
        query: { id: 'next', kind: 'adjacency', path, direction: 'out', limit: 8 },
      },
      {
        id: 'dwellhist',
        viz: 'histogram',
        title: 'Time-on-page distribution',
        w: 6,
        h: 2,
        query: { id: 'dwellhist', kind: 'distribution', of: 'dwell', path },
      },
      {
        id: 'scrollhist',
        viz: 'histogram',
        title: 'Scroll depth',
        w: 6,
        h: 2,
        query: { id: 'scrollhist', kind: 'distribution', of: 'scroll', path },
      },
    ],
  });
}
