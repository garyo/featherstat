import { buildDashboard } from './build.ts';
import type { DashboardTemplate } from './index.ts';

/**
 * Where visitors come from: referrers and channel types, then the UTM axes.
 * The hygiene list groups by `campaign_status` — derived at query time from the
 * campaigns registry (docs/03 § Campaigns), so registry edits reflect instantly.
 */
export const acquisitionTemplate: DashboardTemplate = {
  id: 'acquisition',
  name: 'Acquisition',
  scope: 'site',
  build: (site) =>
    buildDashboard({
      name: 'Acquisition',
      site,
      grid: [
        {
          id: 'kpis',
          viz: 'kpi-row',
          w: 12,
          h: 1,
          query: { id: 'kpis', metrics: ['visitors', 'visits', 'pageviews', 'bounce_rate'] },
          options: { tiles: ['visitors', 'visits', 'pageviews', 'bounce_rate'] },
        },
        {
          id: 'series',
          viz: 'timeseries',
          title: 'Visitors',
          w: 12,
          h: 2,
          query: { id: 'series', metrics: ['visitors'], bucket: 'day' },
        },
        {
          id: 'refs',
          viz: 'bar-list',
          title: 'Referrers',
          w: 6,
          h: 2,
          // Internal navigation carries a `ref_domain` too; see overview.ts.
          query: {
            id: 'refs',
            metrics: ['visitors'],
            dim: 'ref_domain',
            filters: [{ dim: 'ref_type', op: 'neq', value: 'internal' }],
            limit: 10,
          },
          options: { nullLabel: 'Direct' },
        },
        {
          id: 'channels',
          viz: 'bar-list',
          title: 'Channels',
          w: 6,
          h: 2,
          query: { id: 'channels', metrics: ['visits'], dim: 'ref_type', limit: 6 },
          options: { nullLabel: 'Direct' },
        },
        {
          id: 'sources',
          viz: 'bar-list',
          title: 'UTM sources',
          w: 4,
          h: 2,
          query: { id: 'sources', metrics: ['visitors'], dim: 'utm_source', limit: 8 },
          options: { nullLabel: '(untagged)' },
        },
        {
          id: 'mediums',
          viz: 'bar-list',
          title: 'UTM mediums',
          w: 4,
          h: 2,
          query: { id: 'mediums', metrics: ['visitors'], dim: 'utm_medium', limit: 8 },
          options: { nullLabel: '(untagged)' },
        },
        {
          id: 'campaigns',
          viz: 'bar-list',
          title: 'Campaigns',
          w: 4,
          h: 2,
          query: { id: 'campaigns', metrics: ['visitors'], dim: 'utm_campaign', limit: 8 },
          options: { nullLabel: '(untagged)' },
        },
        {
          id: 'hygiene',
          viz: 'bar-list',
          title: 'Campaign hygiene',
          w: 6,
          h: 2,
          query: { id: 'hygiene', metrics: ['visits'], dim: 'campaign_status', limit: 3 },
        },
      ],
    }),
};
