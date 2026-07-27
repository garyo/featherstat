import { type Dashboard, DashboardSchema } from '@analytics/shared';

/**
 * The shipped default site dashboard — deliberately the same JSON document a
 * user's customized dashboard will be (docs/05), parsed rather than cast so it
 * can never drift from the schema user dashboards are validated against. The
 * `site` field is nominal here: views scope the batch from the URL.
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
  ],
});
