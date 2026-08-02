import type { Dashboard } from '../../index.ts';
import { buildDashboard } from '../build.ts';

/**
 * One campaign's detail view (docs/05 § Detail views): its traffic over time,
 * the sources and mediums it arrived under, where it lands, how engaged it is,
 * and its `campaign_status` — whether the campaigns registry knows it.
 */
export function campaignDetail(site: number, utmCampaign: string): Dashboard {
  const tagged = [{ dim: 'utm_campaign', op: 'eq', value: utmCampaign }];
  return buildDashboard({
    name: 'Campaign detail',
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
          filters: tagged,
        },
        options: { tiles: ['visitors', 'visits', 'avg_engagement', 'bounce_rate'] },
      },
      {
        id: 'trend',
        viz: 'timeseries',
        title: 'Visits',
        w: 12,
        h: 2,
        query: { id: 'trend', metrics: ['visits'], bucket: 'day', filters: tagged },
      },
      {
        id: 'sources',
        viz: 'bar-list',
        title: 'Sources & mediums',
        w: 6,
        h: 2,
        query: {
          id: 'sources',
          metrics: ['visits'],
          dim: 'utm_source',
          dim2: 'utm_medium',
          filters: tagged,
          limit: 8,
        },
      },
      {
        id: 'landing',
        viz: 'bar-list',
        title: 'Landing pages',
        w: 6,
        h: 2,
        query: { id: 'landing', metrics: ['visits'], dim: 'entry_path', filters: tagged, limit: 8 },
      },
      {
        id: 'pages',
        viz: 'bar-list',
        title: 'Top pages of its sessions',
        w: 6,
        h: 2,
        query: { id: 'pages', metrics: ['pageviews'], dim: 'path', filters: tagged, limit: 8 },
      },
      {
        id: 'status',
        viz: 'bar-list',
        title: 'Campaign status',
        w: 6,
        h: 2,
        query: { id: 'status', metrics: ['visits'], dim: 'campaign_status', filters: tagged },
      },
    ],
  });
}
