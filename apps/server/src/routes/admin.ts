import { createHash, randomBytes } from 'node:crypto';
import {
  AdminChangePasswordSchema,
  type AdminDiagnostics,
  AdminLoginSchema,
  type AdminPropsResponse,
  AdminSetupSchema,
  AdminSiteCreateSchema,
  AdminSitePatchSchema,
  ApiTokenCreateSchema,
  type ApiTokenInfo,
  type ApiTokenMinted,
  DAY_MS,
  PROP_KEY_PATTERN,
  type SiteInfo,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { verifyPassword } from '../auth/password.ts';
import { parseSiteScope, serializeSiteScope } from '../auth/principal.ts';
import { RateLimiter } from '../auth/ratelimit.ts';
import {
  type ApiTokenRow,
  countEvents,
  createSite,
  type Db,
  databaseSizeBytes,
  deleteAdminSessionsExcept,
  deletePropKey,
  insertApiToken,
  listApiTokens,
  listBotDrops,
  listPropDrops,
  listPropKeys,
  revokeApiToken,
  type Site,
  updateSite,
  withWriteTransaction,
} from '../db/index.ts';
import { requestPropScrub, runPropScrubs } from '../jobs/prop-scrub.ts';
import type { PropRegistry } from '../pipeline/props.ts';
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

export interface AdminRouteOptions {
  /** The live pipeline's prop registry — a delete must invalidate its cache too.
   * Absent (a query-only server, tests), the governance rows alone are dropped. */
  propRegistry?: PropRegistry;
}

export function createAdminRoutes(
  db: Db,
  auth: Auth,
  options: AdminRouteOptions = {},
): Hono<AuthEnv> {
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

  // --- API tokens (docs/04 § 5): mint shows the raw value exactly once ------

  app.get('/api/admin/tokens', (c) => c.json(listApiTokens(db).map(toTokenInfo)));

  app.post('/api/admin/tokens', async (c) => {
    const body = await parseBody(c, ApiTokenCreateSchema);
    if (body.ok === false) return body.response;
    const raw = `fs_${randomBytes(32).toString('base64url')}`;
    const row = {
      name: body.data.name,
      token_hash: createHash('sha256').update(raw).digest(),
      site_scope: serializeSiteScope(body.data.sites),
      created_at: auth.now(),
    };
    const id = withWriteTransaction(db, () => insertApiToken(db, row));
    const minted: ApiTokenMinted = {
      ...toTokenInfo({ id, ...row, last_used_at: null, revoked_at: null }),
      token: raw,
    };
    return c.json(minted, 201);
  });

  app.delete('/api/admin/tokens/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid token id' }, 400);
    const revoked = withWriteTransaction(db, () => revokeApiToken(db, id, auth.now()));
    if (!revoked) return c.json({ error: `no live token ${id}` }, 404);
    return c.json({ ok: true });
  });

  // --- Props governance (docs/03 § Props, docs/04 § 5) ----------------------

  app.get('/api/admin/props', (c) => {
    const siteId = Number(c.req.query('site'));
    if (!Number.isInteger(siteId) || siteId <= 0) return c.json({ error: 'invalid site id' }, 400);
    const since = new Date(auth.now() - (BOT_DROP_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
    const response: AdminPropsResponse = {
      keys: listPropKeys(db, siteId).map((row) => ({
        key: row.key,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        events: row.events,
        distinctValues: row.distinct_values,
        overCapSince: row.over_cap_since,
      })),
      drops: listPropDrops(db, siteId, since).map((row) => ({
        localDate: row.local_date,
        reason: row.reason,
        count: row.count,
      })),
    };
    return c.json(response);
  });

  app.delete('/api/admin/props/:site/:key', (c) => {
    const siteId = Number(c.req.param('site'));
    if (!Number.isInteger(siteId) || siteId <= 0) return c.json({ error: 'invalid site id' }, 400);
    const key = c.req.param('key');
    if (!PROP_KEY_PATTERN.test(key)) return c.json({ error: 'invalid prop key' }, 400);
    // Registry rows, the live cache and the scrub watermark move together —
    // a crash between them could otherwise leave bags no scrub will ever visit.
    const existed = withWriteTransaction(db, () => {
      const known = options.propRegistry?.deleteKey(siteId, key) ?? deletePropKey(db, siteId, key);
      if (known) requestPropScrub(db, siteId, key);
      return known;
    });
    if (!existed) return c.json({ error: `unknown prop key '${key}' on site ${siteId}` }, 404);
    // Kick the chunked scrub now; the scheduler's job resumes it after a crash.
    void runPropScrubs(db).catch((error) => console.error('prop scrub failed:', error));
    return c.json({ ok: true });
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

function toTokenInfo(
  row: Omit<ApiTokenRow, 'token_hash'> & { token_hash?: unknown },
): ApiTokenInfo {
  const scope = parseSiteScope(row.site_scope);
  return {
    id: row.id,
    name: row.name,
    sites: scope === 'all' ? 'all' : [...scope],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
