import { createHash, randomBytes } from 'node:crypto';
import {
  type AdminBotDrops,
  AdminChangePasswordSchema,
  type AdminDataSettings,
  AdminDataSettingsSchema,
  type AdminDiagnostics,
  AdminLoginSchema,
  type AdminMe,
  type AdminPropsResponse,
  AdminSetupSchema,
  AdminSiteCreateSchema,
  AdminSitePatchSchema,
  ApiTokenCreateSchema,
  type ApiTokenInfo,
  type ApiTokenMinted,
  DAY_MS,
  ExclusionSettingsSchema,
  type ExclusionState,
  PROP_KEY_PATTERN,
  type SiteInfo,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import {
  canGrantScope,
  canManageSite,
  parseSiteScope,
  serializeSiteScope,
} from '../auth/principal.ts';
import { RateLimiter } from '../auth/ratelimit.ts';
import {
  type ApiTokenRow,
  addUserSite,
  bumpAnnotationsVersion,
  countEvents,
  createSite,
  type Db,
  type DropCountRow,
  databaseSizeBytes,
  deleteAdminSessionsExcept,
  deleteDashboard,
  deletePropKey,
  deleteSetting,
  deleteSiteAnnotations,
  deleteSiteConfigRows,
  deleteUserSessions,
  getSetting,
  getUser,
  getUserByEmail,
  insertApiToken,
  listApiTokens,
  listBotDrops,
  listDashboards,
  listExcludedDrops,
  listPropDrops,
  listPropKeys,
  removeSiteFromUsers,
  revokeApiToken,
  type Site,
  setSetting,
  setUserPassword,
  tombstoneSite,
  updateSite,
  withWriteTransaction,
} from '../db/index.ts';
import { readAlertRules, writeAlertRules } from '../jobs/alerts.ts';
import {
  BACKUP_DIR_KEY,
  BACKUP_KEEP_KEY,
  backupKeep,
  DEFAULT_BACKUP_KEEP,
} from '../jobs/backup.ts';
import { requestPropScrub, runPropScrubs } from '../jobs/prop-scrub.ts';
import { RETENTION_DAYS_KEY, retentionDays } from '../jobs/retention.ts';
import { requestSitePurge, runSitePurges } from '../jobs/site-purge.ts';
import type { AliasCache } from '../pipeline/campaigns.ts';
import type { ExclusionMatcher } from '../pipeline/exclusions.ts';
import { readExclusionRules, writeExclusionRules } from '../pipeline/exclusions.ts';
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

/**
 * A well-formed hash no password derives to: verified against when a user
 * login names no usable account, so every failure costs the same one scrypt.
 */
const DECOY_HASH =
  'scrypt$32768$8$1$rpiLzxaemhczP2Fh-2tuLpDKFLW31mwfTOiFKCAY4iA$' +
  'woSL-ofmP1MBrXZHifGcdrjFR_D4VGDXqbLd4cdHL7E-MgYA0VteYb4D0MiJhauhhzB1W6oCLJ2lLfnY66XECQ';

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
  /** The live pipeline's campaign-alias cache — a site delete drops its rows. */
  campaignAliases?: AliasCache;
  /** The live exclusion set — a rule write must take effect without a restart.
   * Absent (a query-only server, tests), the settings row alone moves. */
  exclusions?: ExclusionMatcher;
  /** Re-resolves hostname rules after a write, so a new name bites immediately. */
  refreshExclusions?: () => Promise<void>;
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
    // Viewer sessions answer here too: `me` is the auth bootstrap for every
    // cookie principal, and `principal` is how the SPA tells the two apart.
    const who = auth.cookiePrincipal(c);
    if (who === undefined || who.kind === 'token') {
      return c.json({ authenticated: false, needsSetup });
    }
    const me: AdminMe = {
      authenticated: true,
      needsSetup,
      csrf: auth.csrfTokenOf(who.sessionId),
      principal: who.kind,
    };
    if (who.kind === 'user') me.email = getUser(db, who.userId)?.email;
    return c.json(me);
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
    // Email present: a user login. Unknown email, unclaimed invite, disabled
    // user and wrong password all answer identically — and all cost one scrypt,
    // so the response's timing names no emails either.
    if (body.data.email !== undefined) {
      const user = getUserByEmail(db, body.data.email);
      const usableHash =
        user !== undefined && user.disabled_at === null ? user.password_hash : null;
      const ok = await verifyPassword(body.data.password, usableHash ?? DECOY_HASH);
      if (user === undefined || usableHash === null || !ok) {
        return c.json({ error: 'wrong password' }, 401);
      }
      const issued = auth.login(c, { kind: 'user', userId: user.id });
      return c.json({ ok: true, csrf: issued.csrfToken });
    }
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
    const principal = c.get('principal');
    // A user changes their own hash; only the admin touches the settings row.
    if (principal.kind === 'user') {
      const user = getUser(db, principal.userId);
      const hash = user?.password_hash ?? null;
      if (hash === null || !(await verifyPassword(body.data.current, hash))) {
        return c.json({ error: 'current password is wrong' }, 403);
      }
      const next = await hashPassword(body.data.next);
      withWriteTransaction(db, () => {
        setUserPassword(db, principal.userId, next);
        // Every other device is logged out; the changing session stays.
        deleteUserSessions(db, principal.userId, c.get('sessionId'));
      });
      return c.json({ ok: true });
    }
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
    const principal = c.get('principal');
    // Ownership grows on create: a user's new site is theirs, atomically.
    const site = withWriteTransaction(db, () => {
      const created = createSite(db, body.data);
      if (principal.kind === 'user') addUserSite(db, principal.userId, created.id);
      return created;
    });
    return c.json(toSiteInfo(site), 201);
  });

  app.patch('/api/admin/sites/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid site id' }, 400);
    // Out of scope answers exactly like nonexistent — a probe learns nothing.
    if (!canManageSite(c.get('principal'), id)) return c.json({ error: `unknown site ${id}` }, 404);
    const body = await parseBody(c, AdminSitePatchSchema);
    if (body.ok === false) return body.response;
    const site = withWriteTransaction(db, () => updateSite(db, id, body.data));
    if (site === undefined) return c.json({ error: `unknown site ${id}` }, 404);
    return c.json(toSiteInfo(site));
  });

  // Site deletion (docs/04 § 5): tombstone + inline config-row deletes in ONE
  // transaction, then the chunked purge job for the bulk data. The tombstone
  // takes effect immediately — ingest drops the site's beacons like an unknown
  // site's, and it vanishes from every directory and query scope.
  app.delete('/api/admin/sites/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid site id' }, 400);
    if (!canManageSite(c.get('principal'), id)) return c.json({ error: `unknown site ${id}` }, 404);
    const known = withWriteTransaction(db, () => {
      if (!tombstoneSite(db, id, auth.now())) return false;
      deleteSiteConfigRows(db, id);
      removeSiteFromUsers(db, id);
      options.propRegistry?.forgetSite(id);
      if (deleteSiteAnnotations(db, id) > 0) bumpAnnotationsVersion(db);
      // deleteDashboard revokes the dashboard's share tokens with it.
      for (const dashboard of listDashboards(db)) {
        if (dashboard.site_scope === String(id)) deleteDashboard(db, dashboard.id);
      }
      const rules = readAlertRules(db);
      const kept = rules.filter((rule) => rule.site !== id);
      if (kept.length !== rules.length) writeAlertRules(db, kept);
      requestSitePurge(db, id);
      return true;
    });
    if (!known) return c.json({ error: `unknown site ${id}` }, 404);
    options.campaignAliases?.invalidate();
    // Kick the chunked purge now; the scheduler's job resumes it after a crash.
    void runSitePurges(db).catch((error) => console.error('site purge failed:', error));
    return c.json({ ok: true });
  });

  // --- Data settings (docs/02 § Background jobs): retention + backup knobs ---

  const dataSettings = (): AdminDataSettings => ({
    retentionDays: retentionDays(db) ?? null,
    backupDir: getSetting(db, BACKUP_DIR_KEY) ?? null,
    backupKeep: backupKeep(db),
  });

  app.get('/api/admin/data-settings', (c) => c.json(dataSettings()));

  app.put('/api/admin/data-settings', async (c) => {
    const body = await parseBody(c, AdminDataSettingsSchema);
    if (body.ok === false) return body.response;
    const next = body.data;
    withWriteTransaction(db, () => {
      if (next.retentionDays === null) deleteSetting(db, RETENTION_DAYS_KEY);
      else setSetting(db, RETENTION_DAYS_KEY, String(next.retentionDays));
      if (next.backupDir === null) deleteSetting(db, BACKUP_DIR_KEY);
      else setSetting(db, BACKUP_DIR_KEY, next.backupDir);
      if (next.backupKeep === DEFAULT_BACKUP_KEEP) deleteSetting(db, BACKUP_KEEP_KEY);
      else setSetting(db, BACKUP_KEEP_KEY, String(next.backupKeep));
    });
    return c.json(dataSettings());
  });

  // --- API tokens (docs/04 § 5): mint shows the raw value exactly once ------

  /** A user sees and revokes only their own mints; the admin sees all. */
  const ownsMint = (c: Context, createdBy: number | null): boolean => {
    const principal = c.get('principal');
    return principal.kind !== 'user' || createdBy === principal.userId;
  };

  app.get('/api/admin/tokens', (c) =>
    c.json(
      listApiTokens(db)
        .filter((row) => ownsMint(c, row.created_by_user_id))
        .map(toTokenInfo),
    ),
  );

  app.post('/api/admin/tokens', async (c) => {
    const body = await parseBody(c, ApiTokenCreateSchema);
    if (body.ok === false) return body.response;
    const principal = c.get('principal');
    if (!canGrantScope(principal, body.data.sites)) {
      return c.json({ error: 'scope exceeds your sites' }, 400);
    }
    const raw = `fs_${randomBytes(32).toString('base64url')}`;
    const row = {
      name: body.data.name,
      token_hash: createHash('sha256').update(raw).digest(),
      site_scope: serializeSiteScope(body.data.sites),
      created_at: auth.now(),
      created_by_user_id: principal.kind === 'user' ? principal.userId : null,
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
    // Someone else's mint answers exactly like a nonexistent one.
    const row = listApiTokens(db).find((token) => token.id === id);
    if (row === undefined || !ownsMint(c, row.created_by_user_id)) {
      return c.json({ error: `no live token ${id}` }, 404);
    }
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

  // --- Traffic exclusion (docs/03 § Exclusions) ------------------------------

  app.get('/api/admin/exclusions', (c) => {
    const state: ExclusionState = {
      rules: [...(options.exclusions?.current() ?? readExclusionRules(db))],
      resolutions: options.exclusions?.resolutions() ?? [],
    };
    return c.json(state);
  });

  app.put('/api/admin/exclusions', async (c) => {
    const body = await parseBody(c, ExclusionSettingsSchema);
    if (body.ok === false) return body.response;
    const { rules } = body.data;
    withWriteTransaction(db, () => writeExclusionRules(db, rules));
    // The row is the record; the live matcher is what ingest actually consults,
    // so it moves in the same request or the rule would not bite until restart.
    options.exclusions?.setRules(rules);
    // Resolve now rather than waiting out the refresh interval: an operator who
    // just typed their hostname expects it to be excluded, not excluded in five
    // minutes. A failure here is reported through the resolution, not the status.
    await options.refreshExclusions?.();
    const state: ExclusionState = {
      rules,
      resolutions: options.exclusions?.resolutions() ?? [],
    };
    return c.json(state);
  });

  app.get('/api/admin/diagnostics', (c) => {
    // UTC approximation of the per-site local dates — fine for a health panel.
    const since = new Date(auth.now() - (BOT_DROP_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
    const diagnostics: AdminDiagnostics = {
      dbSizeBytes: databaseSizeBytes(db),
      eventCount: countEvents(db),
      botDrops: listBotDrops(db, since).map(toDropCounts),
      excludedDrops: listExcludedDrops(db, since).map(toDropCounts),
    };
    return c.json(diagnostics);
  });

  return app;
}

const toDropCounts = (row: DropCountRow): AdminBotDrops => ({
  siteId: row.site_id,
  localDate: row.local_date,
  count: row.count,
});

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
