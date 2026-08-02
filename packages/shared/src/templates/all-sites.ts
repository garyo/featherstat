import { buildDashboard } from './build.ts';
import type { DashboardTemplate } from './index.ts';

/**
 * The all-sites overview is a dashboard like any other (docs/05: everything is
 * a widget). One daily-bucketed query answers everything the cards show;
 * active-now rides the SSE stream, not the batch. The site ids become one
 * top-pages trend query per site (R20) — companions in the SAME batch, declared
 * via the widget's options. The web view (and the server's reset route) build
 * with the LIVE directory; a stored clone is refreshed on read by
 * `withLiveSiteIds`, so a new site never misses its card.
 */
export const allSitesTemplate: DashboardTemplate = {
  id: 'all-sites',
  name: 'All sites',
  scope: 'all',
  build: (_site, siteIds = []) =>
    buildDashboard({
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
};
