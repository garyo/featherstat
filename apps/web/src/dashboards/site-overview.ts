import { type Dashboard, DashboardSchema } from '@featherstat/shared';

/**
 * The shipped default site dashboard — deliberately the same JSON document a
 * user's customized dashboard will be (docs/05), parsed rather than cast so it
 * can never drift from the schema user dashboards are validated against. The
 * `site` field is nominal here: views scope the batch from the URL. The grid
 * follows the mockup's arrangement: KPIs → main series → pages/referrers →
 * countries/devices/events → hours heatmap.
 */
export const siteOverview: Dashboard = DashboardSchema.parse({
  name: 'Site overview',
  site: 1,
  grid: [
    {
      id: 'kpis',
      viz: 'kpi-row',
      w: 12,
      h: 1,
      query: {
        id: 'kpis',
        metrics: ['visitors', 'pageviews', 'visits', 'engaged_ms', 'bounce_rate'],
      },
      options: { tiles: ['visitors', 'pageviews', 'avg_engagement', 'bounce_rate'] },
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
      id: 'heatmap',
      viz: 'heatmap',
      title: 'Traffic by hour',
      w: 12,
      h: 2,
      query: { id: 'heatmap', metrics: ['pageviews'], dim: 'local_hour', dim2: 'weekday' },
    },
  ],
});
