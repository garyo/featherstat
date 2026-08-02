import type { Dashboard } from '../../index.ts';
import { buildDashboard } from '../build.ts';

/**
 * One referrer domain's detail view (docs/05 § Detail views): the traffic it
 * sends, where that traffic lands, how engaged it is, and which campaigns ride
 * it. `ref_domain` is a session-level attribute, so one plain filter per
 * widget asks every question here without blocking any metric.
 */
export function referrerDetail(site: number, refDomain: string): Dashboard {
  const from = [{ dim: 'ref_domain', op: 'eq', value: refDomain }];
  return buildDashboard({
    name: 'Referrer detail',
    site,
    grid: [
      {
        id: 'kpis',
        viz: 'kpi-row',
        w: 12,
        h: 1,
        query: {
          id: 'kpis',
          metrics: [
            'visitors',
            'visits',
            'pageviews',
            'engaged_ms',
            'engaged_sessions',
            'avg_engagement',
            'bounce_rate',
          ],
          filters: from,
        },
        options: { tiles: ['visitors', 'visits', 'avg_engagement', 'bounce_rate'] },
      },
      {
        id: 'trend',
        viz: 'timeseries',
        title: 'Visits',
        w: 12,
        h: 2,
        query: { id: 'trend', metrics: ['visits'], bucket: 'day', filters: from },
      },
      {
        id: 'landing',
        viz: 'bar-list',
        title: 'Landing pages',
        w: 6,
        h: 2,
        query: { id: 'landing', metrics: ['visits'], dim: 'entry_path', filters: from, limit: 8 },
      },
      {
        id: 'pages',
        viz: 'bar-list',
        title: 'Top pages of its sessions',
        w: 6,
        h: 2,
        query: { id: 'pages', metrics: ['pageviews'], dim: 'path', filters: from, limit: 8 },
      },
      {
        id: 'campaigns',
        viz: 'bar-list',
        title: 'Campaigns it carries',
        w: 6,
        h: 2,
        query: {
          id: 'campaigns',
          metrics: ['visits'],
          dim: 'utm_campaign',
          filters: from,
          limit: 8,
        },
        options: { nullLabel: '(untagged)' },
      },
      {
        id: 'countries',
        viz: 'bar-list',
        title: 'Countries',
        w: 6,
        h: 2,
        query: { id: 'countries', metrics: ['visitors'], dim: 'country', filters: from, limit: 8 },
        options: { flags: true, nullLabel: 'Unknown' },
      },
    ],
  });
}
