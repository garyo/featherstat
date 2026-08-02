import { buildDashboard } from './build.ts';
import type { DashboardTemplate } from './index.ts';

/**
 * Campaign performance over the UTM layer and the registry-derived
 * `campaign_status`. Templates are static documents, so no goal widgets ride
 * here — goals are per-site configuration a template cannot know about; the
 * operator adds goal tiles to their clone.
 */
export const campaignsTemplate: DashboardTemplate = {
  id: 'campaigns',
  name: 'Campaigns',
  scope: 'site',
  build: (site) =>
    buildDashboard({
      name: 'Campaigns',
      site,
      grid: [
        {
          id: 'kpis',
          viz: 'kpi-row',
          w: 12,
          h: 1,
          query: { id: 'kpis', metrics: ['visitors', 'visits', 'pageviews', 'events'] },
          options: { tiles: ['visitors', 'visits', 'pageviews', 'events'] },
        },
        {
          id: 'series',
          viz: 'timeseries',
          title: 'Visits by day',
          w: 12,
          h: 2,
          query: { id: 'series', metrics: ['visits', 'visitors'], bucket: 'day' },
        },
        {
          id: 'campaigns',
          viz: 'bar-list',
          title: 'Campaigns',
          w: 6,
          h: 2,
          query: { id: 'campaigns', metrics: ['visitors'], dim: 'utm_campaign', limit: 10 },
          options: { nullLabel: '(untagged)' },
        },
        {
          id: 'bysource',
          viz: 'bar-list',
          title: 'Campaign × source',
          w: 6,
          h: 2,
          query: {
            id: 'bysource',
            metrics: ['visits'],
            dim: 'utm_campaign',
            dim2: 'utm_source',
            limit: 10,
          },
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
        {
          id: 'mediums',
          viz: 'bar-list',
          title: 'UTM mediums',
          w: 6,
          h: 2,
          query: { id: 'mediums', metrics: ['visits'], dim: 'utm_medium', limit: 8 },
          options: { nullLabel: '(untagged)' },
        },
      ],
    }),
};
