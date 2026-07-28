import {
  AdminChangePasswordSchema,
  type AdminDiagnostics,
  AdminLoginSchema,
  AdminSetupSchema,
  AdminSiteCreateSchema,
  AdminSitePatchSchema,
  DAY_MS,
  type SiteInfo,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { verifyPassword } from '../auth/password.ts';
import { RateLimiter } from '../auth/ratelimit.ts';
import {
  countEvents,
  createSite,
  type Db,
  databaseSizeBytes,
  deleteAdminSessionsExcept,
  listBotDrops,
  type Site,
  updateSite,
  withWriteTransaction,
} from '../db/index.ts';
import { clientIp } from './track.ts';

/**
 * `/api/admin` (docs/04 § 5): auth lifecycle, sites CRUD, diagnostics. Login,
 * setup and `me` are registered before the gate — everything after it needs a
 * live session, and mutations additionally pass the CSRF guard.
 *
 * First-run state machine: while no password hash exists, `setup` is the only
 * mutation that succeeds; the gate 401s all other admin (and dashboard) routes.
 */

const LOGIN_LIMIT = 5;
/** Backstop across ALL keys: a spoofed-header flood must still hit a wall. */
const GLOBAL_LOGIN_LIMIT = 30;
const LOGIN_WINDOW_MS = 60_000;
/** Admin bodies are a password or a site record — far under this. */
const MAX_ADMIN_BODY_BYTES = 64 * 1024;
/** Diagnostics window: today plus six prior site-local dates. */
const BOT_DROP_DAYS = 7;

export function createAdminRoutes(db: Db, auth: Auth): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const loginAttempts = new RateLimiter(LOGIN_LIMIT, LOGIN_WINDOW_MS);
  const globalAttempts = new RateLimiter(GLOBAL_LOGIN_LIMIT, LOGIN_WINDOW_MS);

  /** Both budgets always record, so a spoofed per-key flood still burns the global one. */
  const allowAttempt = (c: Context): boolean => {
    const perIp = loginAttempts.allow(clientIp(c), auth.now());
    const global = globalAttempts.allow('*', auth.now());
    return perIp && global;
  };

  app.use('/api/admin/*', bodyLimit({ maxSize: MAX_ADMIN_BODY_BYTES }));
  // Responses carry session-derived material (the CSRF token) — never cacheable.
  app.use('/api/admin/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });

  app.get('/api/admin/me', (c) => {
    const needsSetup = !auth.disabled && !auth.hasPassword();
    const sessionId = auth.sessionOf(c);
    if (sessionId === undefined) return c.json({ authenticated: false, needsSetup });
    return c.json({ authenticated: true, needsSetup, csrf: auth.csrfTokenOf(sessionId) });
  });

  app.post('/api/admin/setup', async (c) => {
    if (!allowAttempt(c)) {
      return c.json({ error: 'too many attempts — try again in a minute' }, 429);
    }
    if (auth.hasPassword()) return c.json({ error: 'already configured — log in instead' }, 403);
    const body = await parseBody(c, AdminSetupSchema);
    if (body.ok === false) return body.response;
    if (!auth.verifySetupToken(body.data.setupToken)) {
      return c.json({ error: 'wrong setup token — it is printed in the server log' }, 403);
    }
    await auth.setPassword(body.data.password);
    console.log('first-run setup complete: admin password set, setup token consumed');
    const issued = auth.login(c);
    return c.json({ ok: true, csrf: issued.csrfToken });
  });

  app.post('/api/admin/login', async (c) => {
    if (!allowAttempt(c)) {
      return c.json({ error: 'too many attempts — try again in a minute' }, 429);
    }
    const hash = auth.passwordHash();
    if (hash === undefined) return c.json({ error: 'setup required' }, 403);
    const body = await parseBody(c, AdminLoginSchema);
    if (body.ok === false) return body.response;
    if (!(await verifyPassword(body.data.password, hash))) {
      return c.json({ error: 'wrong password' }, 401);
    }
    const issued = auth.login(c);
    return c.json({ ok: true, csrf: issued.csrfToken });
  });

  app.use('/api/admin/*', auth.gate);
  app.use('/api/admin/*', auth.csrfGuard);

  app.post('/api/admin/logout', (c) => {
    auth.logout(c, c.get('sessionId'));
    return c.json({ ok: true });
  });

  app.post('/api/admin/password', async (c) => {
    const body = await parseBody(c, AdminChangePasswordSchema);
    if (body.ok === false) return body.response;
    const hash = auth.passwordHash();
    if (hash === undefined || !(await verifyPassword(body.data.current, hash))) {
      return c.json({ error: 'current password is wrong' }, 403);
    }
    await auth.setPassword(body.data.next);
    // Every other device is logged out; the session that changed the password stays.
    withWriteTransaction(db, () => deleteAdminSessionsExcept(db, c.get('sessionId')));
    return c.json({ ok: true });
  });

  app.post('/api/admin/sites', async (c) => {
    const body = await parseBody(c, AdminSiteCreateSchema);
    if (body.ok === false) return body.response;
    const site = withWriteTransaction(db, () => createSite(db, body.data));
    return c.json(toSiteInfo(site), 201);
  });

  app.patch('/api/admin/sites/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid site id' }, 400);
    const body = await parseBody(c, AdminSitePatchSchema);
    if (body.ok === false) return body.response;
    const site = withWriteTransaction(db, () => updateSite(db, id, body.data));
    if (site === undefined) return c.json({ error: `unknown site ${id}` }, 404);
    return c.json(toSiteInfo(site));
  });

  app.get('/api/admin/diagnostics', (c) => {
    // UTC approximation of the per-site local dates — fine for a health panel.
    const since = new Date(auth.now() - (BOT_DROP_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
    const diagnostics: AdminDiagnostics = {
      dbSizeBytes: databaseSizeBytes(db),
      eventCount: countEvents(db),
      botDrops: listBotDrops(db, since).map((row) => ({
        siteId: row.site_id,
        localDate: row.local_date,
        count: row.count,
      })),
    };
    return c.json(diagnostics);
  });

  return app;
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** The slice of a zod schema this file uses — keeps zod out of the server's own deps. */
interface SchemaLike<T> {
  safeParse(
    raw: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

/** Admin endpoints are not beacons: malformed bodies get a 400 with the zod issues. */
async function parseBody<T>(c: Context, schema: SchemaLike<T>): Promise<Parsed<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: 'invalid request', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

function toSiteInfo({ id, name, domains, timezone }: Site): SiteInfo {
  return { id, name, domains, timezone };
}
