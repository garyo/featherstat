import type { SiteInfo } from '@featherstat/shared';
import { Hono } from 'hono';
import type { AuthVariables } from '../auth/auth.ts';
import { canReadSite } from '../auth/principal.ts';
import { type Db, listSites } from '../db/index.ts';

/**
 * GET /api/sites — the read-only site directory (docs/05: site names in the
 * header switcher, cards, and document titles). Deliberately a projection:
 * `created_at` and anything an admin surface may grow stay out of this
 * public-to-the-dashboard shape. A scoped principal (viewer, token) sees only
 * its readable sites — to it, the rest of the directory does not exist.
 */
export function createSiteRoutes(db: Db): Hono<{ Variables: Partial<AuthVariables> }> {
  const app = new Hono<{ Variables: Partial<AuthVariables> }>();
  app.get('/api/sites', (c) => {
    const who = c.get('principal');
    const sites: SiteInfo[] = listSites(db)
      .filter((site) => who === undefined || canReadSite(who, site.id))
      .map(({ id, name, domains, timezone }) => ({ id, name, domains, timezone }));
    return c.json(sites);
  });
  return app;
}
