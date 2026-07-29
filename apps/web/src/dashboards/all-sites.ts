import { type Dashboard, DashboardSchema, upgradeDashboard } from '@featherstat/shared';

/**
 * The all-sites overview is a dashboard like any other (docs/05: everything is
 * a widget). One daily-bucketed query answers everything the cards show:
 * today's visitors, the delta vs the same weekday last week, and the 14-day
 * sparkline; active-now rides the SSE stream, not the batch. The site ids from
 * `/api/sites` become one top-pages trend query per site (R20) — companions in
 * the SAME batch, declared via the widget's options. Carried forward by the same
 * upgrade steps a stored layout is, for the reason site-overview.ts states.
 */
export function allSites(siteIds: readonly number[]): Dashboard {
  return upgradeDashboard(
    DashboardSchema.parse({
      name: 'All sites',
      site: 'all',
      grid: [
        {
          id: 'sites',
          viz: 'site-cards',
          w: 12,
          h: 3,
          query: { id: 'sites', metrics: ['visitors'], bucket: 'day', dim: 'site' },
          options: { siteIds: [...siteIds] },
        },
      ],
    }),
  );
}
