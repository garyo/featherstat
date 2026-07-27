import { type Dashboard, DashboardSchema } from '@analytics/shared';

/**
 * The all-sites overview is a dashboard like any other (docs/05: everything is
 * a widget). One daily-bucketed query answers everything the cards show:
 * today's visitors, the delta vs the same weekday last week, and the 14-day
 * sparkline; active-now rides the SSE stream, not the batch.
 */
export const allSites: Dashboard = DashboardSchema.parse({
  name: 'All sites',
  site: 'all',
  grid: [
    {
      id: 'sites',
      viz: 'site-cards',
      w: 12,
      h: 3,
      query: { id: 'sites', metrics: ['visitors'], bucket: 'day', dim: 'site' },
    },
  ],
});
