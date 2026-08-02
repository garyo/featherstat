import { buildDashboard } from './build.ts';
import type { DashboardTemplate } from './index.ts';

/**
 * The shipped default site dashboard — the mockup's arrangement: KPIs → what
 * changed → main series → pages/referrers → countries/devices/events →
 * outbound links/time on page → hours heatmap. The changes card compares, so
 * it reads from the view's compare control and refuses honestly at `cmp=off`.
 */
export const overviewTemplate: DashboardTemplate = {
  id: 'overview',
  name: 'Site overview',
  scope: 'site',
  build: (site) =>
    buildDashboard({
      name: 'Site overview',
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
              'pageviews',
              'visits',
              'engaged_ms',
              'engaged_sessions',
              'avg_engagement',
              'bounce_rate',
            ],
          },
          options: { tiles: ['visitors', 'pageviews', 'avg_engagement', 'bounce_rate'] },
        },
        {
          id: 'changes',
          viz: 'changes',
          title: 'What changed',
          w: 12,
          h: 2,
          query: { id: 'changes', kind: 'changes' },
        },
        {
          id: 'series',
          viz: 'timeseries',
          title: 'Visitors & pageviews',
          w: 12,
          h: 2,
          query: { id: 'series', metrics: ['visitors', 'pageviews'], bucket: 'day' },
        },
        {
          id: 'pages',
          viz: 'bar-list',
          title: 'Top pages',
          w: 6,
          h: 2,
          query: { id: 'pages', metrics: ['pageviews'], dim: 'path', limit: 8 },
        },
        {
          id: 'refs',
          viz: 'bar-list',
          title: 'Referrers',
          w: 6,
          h: 2,
          query: { id: 'refs', metrics: ['visitors'], dim: 'ref_domain', limit: 8 },
          options: { nullLabel: 'Direct' },
        },
        {
          id: 'countries',
          viz: 'bar-list',
          title: 'Countries',
          w: 4,
          h: 2,
          query: { id: 'countries', metrics: ['visitors'], dim: 'country', limit: 7 },
          options: { flags: true, nullLabel: 'Unknown' },
        },
        {
          id: 'devices',
          viz: 'devices',
          title: 'Devices & browsers',
          w: 4,
          h: 2,
          query: { id: 'devices', metrics: ['visitors'], dim: 'device_type' },
        },
        {
          id: 'events',
          viz: 'bar-list',
          title: 'Events',
          w: 4,
          h: 2,
          query: {
            id: 'events',
            metrics: ['events', 'event_value_sum'],
            dim: 'event_category',
            dim2: 'event_action',
            limit: 7,
          },
        },
        {
          id: 'outlinks',
          viz: 'bar-list',
          title: 'Outbound links',
          w: 6,
          h: 2,
          query: { id: 'outlinks', metrics: ['outlinks'], dim: 'target_url', limit: 10 },
        },
        {
          id: 'dwell',
          viz: 'dwell',
          title: 'Time on page',
          w: 6,
          h: 2,
          query: { id: 'dwell', kind: 'dwell', limit: 10 },
        },
        {
          id: 'heatmap',
          viz: 'heatmap',
          title: 'Traffic by hour',
          w: 12,
          h: 2,
          query: { id: 'heatmap', metrics: ['pageviews'], dim: 'local_hour', dim2: 'weekday' },
        },
      ],
    }),
};
