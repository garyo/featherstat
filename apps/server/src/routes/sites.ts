import type { SiteInfo } from '@analytics/shared';
import { Hono } from 'hono';
import { type Db, listSites } from '../db/index.ts';

/**
 * GET /api/sites — the read-only site directory (docs/05: site names in the
 * header switcher, cards, and document titles). Deliberately a projection:
 * `created_at` and anything an admin surface may grow stay out of this
 * public-to-the-dashboard shape.
 */
export function createSiteRoutes(db: Db): Hono {
  const app = new Hono();
  app.get('/api/sites', (c) => {
    const sites: SiteInfo[] = listSites(db).map(({ id, name, domains, timezone }) => ({
      id,
      name,
      domains,
      timezone,
    }));
    return c.json(sites);
  });
  return app;
}
