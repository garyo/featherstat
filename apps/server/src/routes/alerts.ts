import { AlertRulesSchema } from '@featherstat/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { type Db, getSite, withWriteTransaction } from '../db/index.ts';
import { readAlertRules, writeAlertRules } from '../jobs/alerts.ts';

/**
 * `GET`/`PUT /api/admin/alerts` (docs/04 § 5): the alert-rule list, stored as
 * one settings row exactly like the ntfy hit rules and evaluated hourly by
 * jobs/alerts.ts. A PUT is a full replacement — a rule list is small enough
 * that patch semantics would only add ways to be surprised.
 */

const ALERTS_ADMIN_PATH = '/api/admin/alerts';
/** A rule list, nothing more (the shared schema caps it far below this). */
const MAX_BODY_BYTES = 64 * 1024;

export function createAlertRoutes(db: Db, auth: Auth): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use(ALERTS_ADMIN_PATH, bodyLimit({ maxSize: MAX_BODY_BYTES }));
  app.use(ALERTS_ADMIN_PATH, auth.gate);
  app.use(ALERTS_ADMIN_PATH, auth.csrfGuard);
  app.use(ALERTS_ADMIN_PATH, async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });

  app.get(ALERTS_ADMIN_PATH, (c) => c.json({ rules: readAlertRules(db) }));

  app.put(ALERTS_ADMIN_PATH, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    const parsed = AlertRulesSchema.safeParse(
      typeof raw === 'object' && raw !== null && 'rules' in raw ? raw.rules : raw,
    );
    if (!parsed.success) {
      return c.json({ error: 'invalid alert rules', issues: parsed.error.issues }, 400);
    }
    // A rule watching a site that does not exist would evaluate forever against
    // nothing — refuse it now, while the author is looking.
    for (const rule of parsed.data) {
      if (getSite(db, rule.site) === undefined) {
        return c.json({ error: `unknown site ${rule.site}` }, 404);
      }
    }
    withWriteTransaction(db, () => writeAlertRules(db, parsed.data));
    return c.json({ rules: readAlertRules(db) });
  });

  return app;
}
