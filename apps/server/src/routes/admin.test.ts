import { AdminPropsResponseSchema, type SiteInfo } from '@featherstat/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { event, openTestDb, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import {
  createDashboard,
  type Db,
  getSetting,
  getSite,
  incrementBotDrops,
  insertEvents,
  insertShareToken,
  listPropKeys,
  listSites,
  stmt,
  withWriteTransaction,
} from '../db/index.ts';
import { readAlertRules, writeAlertRules } from '../jobs/alerts.ts';
import { runPropScrubs } from '../jobs/prop-scrub.ts';
import { runSitePurges } from '../jobs/site-purge.ts';
import { PropRegistry } from '../pipeline/props.ts';
import { createAdminRoutes } from './admin.ts';

const PASSWORD = 'a-decent-password';

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;
let clock: number;

beforeEach(async () => {
  db = openTestDb(2);
  clock = T0;
  auth = createAuth(db, { now: () => clock, env: {}, log: () => {} });
  app = new Hono<AuthEnv>().route('/', createAdminRoutes(db, auth));
  await auth.setPassword(PASSWORD);
});

afterEach(() => {
  db.close();
});

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .join('; ');
}

async function login(password = PASSWORD): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  expect(res.status).toBe(200);
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie: cookiesOf(res), csrf };
}

interface Session {
  cookie: string;
  csrf: string;
}

async function mutate(
  session: Session,
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('sites CRUD', () => {
  it('creates a site with defaults and lists it back', async () => {
    const session = await login();
    const res = await mutate(session, 'POST', '/api/admin/sites', { name: 'Blog' });
    expect(res.status).toBe(201);
    const site = (await res.json()) as SiteInfo;
    expect(site).toEqual({
      id: 3,
      name: 'Blog',
      domains: [],
      timezone: 'America/New_York',
    });
    expect(getSite(db, 3)?.name).toBe('Blog');
  });

  it('creates with explicit domains and timezone', async () => {
    const session = await login();
    const res = await mutate(session, 'POST', '/api/admin/sites', {
      name: 'Docs',
      domains: ['docs.test', 'www.docs.test'],
      timezone: 'Europe/Berlin',
    });
    expect(res.status).toBe(201);
    const site = (await res.json()) as SiteInfo;
    expect(site.domains).toEqual(['docs.test', 'www.docs.test']);
    expect(site.timezone).toBe('Europe/Berlin');
  });

  it('rejects invalid creations: empty name, bad timezone', async () => {
    const session = await login();
    for (const body of [
      {},
      { name: '' },
      { name: 'X', timezone: 'Mars/Olympus_Mons' },
      { name: 'X', domains: [''] },
    ]) {
      const res = await mutate(session, 'POST', '/api/admin/sites', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('patches name, domains and timezone independently', async () => {
    const session = await login();
    const rename = await mutate(session, 'PATCH', '/api/admin/sites/1', { name: 'Renamed' });
    expect(rename.status).toBe(200);
    expect(((await rename.json()) as SiteInfo).name).toBe('Renamed');

    const domains = await mutate(session, 'PATCH', '/api/admin/sites/1', {
      domains: ['one.test', 'alias.test'],
    });
    expect(((await domains.json()) as SiteInfo).domains).toEqual(['one.test', 'alias.test']);

    const tz = await mutate(session, 'PATCH', '/api/admin/sites/1', { timezone: 'UTC' });
    expect(((await tz.json()) as SiteInfo).timezone).toBe('UTC');

    const site = getSite(db, 1);
    expect(site).toMatchObject({
      name: 'Renamed',
      domains: ['one.test', 'alias.test'],
      timezone: 'UTC',
    });
  });

  it('404s an unknown site, 400s an empty patch and a bad id', async () => {
    const session = await login();
    expect((await mutate(session, 'PATCH', '/api/admin/sites/99', { name: 'X' })).status).toBe(404);
    expect((await mutate(session, 'PATCH', '/api/admin/sites/1', {})).status).toBe(400);
    expect((await mutate(session, 'PATCH', '/api/admin/sites/zero', { name: 'X' })).status).toBe(
      400,
    );
  });
});

describe('password change', () => {
  it('requires the current password', async () => {
    const session = await login();
    const res = await mutate(session, 'POST', '/api/admin/password', {
      current: 'not-the-password',
      next: 'a-brand-new-password',
    });
    expect(res.status).toBe(403);
  });

  it('rotates the password and revokes every other session', async () => {
    const other = await login();
    const session = await login();
    const res = await mutate(session, 'POST', '/api/admin/password', {
      current: PASSWORD,
      next: 'a-brand-new-password',
    });
    expect(res.status).toBe(200);

    // The changing session survives; the other one is gone.
    const me = await app.request('/api/admin/me', { headers: { cookie: session.cookie } });
    expect(((await me.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const revoked = await app.request('/api/admin/diagnostics', {
      headers: { cookie: other.cookie },
    });
    expect(revoked.status).toBe(401);

    // Old password out, new password in.
    const stale = await app.request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(stale.status).toBe(401);
    await login('a-brand-new-password');
  });

  it('holds the new password to the setup strength floor', async () => {
    const session = await login();
    const res = await mutate(session, 'POST', '/api/admin/password', {
      current: PASSWORD,
      next: 'short',
    });
    expect(res.status).toBe(400);
  });
});

describe('props governance (docs/03 § Props)', () => {
  /** Admit through a live registry and land its rows, the way ingest would. */
  function seedProps(registry: PropRegistry): void {
    withWriteTransaction(db, () => {
      insertEvents(db, [
        event({ props: registry.admit(1, { plan: 'pro' }, '2026-07-27', 'pageview', T0) }),
        event({ seq: 2, props: registry.admit(1, { plan: 'free' }, '2026-07-27', 'pageview', T0) }),
      ]);
      registry.admit(1, { plan: 'x' }, '2026-07-27', 'ping', T0); // → an on_ping drop
      registry.apply(db);
    });
    registry.committed();
  }

  it("lists a site's keys with their stats and recent drops", async () => {
    const registry = new PropRegistry(db);
    app = new Hono<AuthEnv>().route('/', createAdminRoutes(db, auth, { propRegistry: registry }));
    seedProps(registry);
    const { cookie } = await login();
    const res = await app.request('/api/admin/props?site=1', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = AdminPropsResponseSchema.parse(await res.json());
    expect(body.keys).toEqual([
      {
        key: 'plan',
        firstSeen: T0,
        lastSeen: T0,
        events: 2,
        distinctValues: 2,
        overCapSince: null,
      },
    ]);
    expect(body.drops).toEqual([{ localDate: '2026-07-27', reason: 'on_ping', count: 1 }]);

    const bad = await app.request('/api/admin/props?site=zero', { headers: { cookie } });
    expect(bad.status).toBe(400);
  });

  it('deletes a key: registry rows now, stored bags scrubbed, 404 for a stranger', async () => {
    const registry = new PropRegistry(db);
    app = new Hono<AuthEnv>().route('/', createAdminRoutes(db, auth, { propRegistry: registry }));
    seedProps(registry);
    const session = await login();

    const missing = await mutate(session, 'DELETE', '/api/admin/props/1/unknown', undefined);
    expect(missing.status).toBe(404);
    const badKey = await mutate(session, 'DELETE', '/api/admin/props/1/Bad%20Key', undefined);
    expect(badKey.status).toBe(400);

    const res = await mutate(session, 'DELETE', '/api/admin/props/1/plan', undefined);
    expect(res.status).toBe(200);
    expect(listPropKeys(db, 1)).toEqual([]);
    // The route kicked the chunked scrub; joining the in-flight run (or a
    // fresh no-op one) proves the stored bags went with the key.
    await runPropScrubs(db);
    const bags = stmt(db, 'SELECT props FROM events').pluck().all();
    expect(bags).toEqual([null, null]);
  });
});

describe('diagnostics', () => {
  it('surfaces bot drops (last 7 days), event count and db size', async () => {
    withWriteTransaction(db, () => {
      insertEvents(db, [event(), event({ seq: 2 })]);
      incrementBotDrops(db, 1, '2026-07-27', 4);
      incrementBotDrops(db, 2, '2026-07-25', 1);
      incrementBotDrops(db, 1, '2026-07-01', 9); // outside the window
    });
    const { cookie } = await login();
    const res = await app.request('/api/admin/diagnostics', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dbSizeBytes: number;
      eventCount: number;
      botDrops: unknown[];
    };
    expect(body.eventCount).toBe(2);
    expect(body.dbSizeBytes).toBeGreaterThan(0);
    expect(body.botDrops).toEqual([
      { siteId: 1, localDate: '2026-07-27', count: 4 },
      { siteId: 2, localDate: '2026-07-25', count: 1 },
    ]);
  });
});

describe('site deletion (docs/04 § 5)', () => {
  function seedSiteObjects(): number {
    return withWriteTransaction(db, () => {
      insertEvents(db, [event(), event({ seq: 2 }), { ...event(), site_id: 2 }]);
      stmt(
        db,
        'INSERT INTO goals (site_id, name, filters, created_at, updated_at) VALUES (1, ?, ?, 0, 0)',
      ).run('signup', '[]');
      stmt(db, 'INSERT INTO campaigns (site_id, name, created_at) VALUES (1, ?, 0)').run('spring');
      stmt(
        db,
        'INSERT INTO campaign_aliases (site_id, field, alias, canonical) VALUES (1, ?, ?, ?)',
      ).run('source', 'em', 'email');
      stmt(
        db,
        'INSERT INTO prop_keys (site_id, key, first_seen, last_seen, events, distinct_values) VALUES (1, ?, 0, 0, 1, 1)',
      ).run('plan');
      stmt(
        db,
        'INSERT INTO annotations (site_id, ts, text, created_at, updated_at) VALUES (1, 0, ?, 0, 0)',
      ).run('launch');
      stmt(
        db,
        'INSERT INTO annotations (site_id, ts, text, created_at, updated_at) VALUES (NULL, 0, ?, 0, 0)',
      ).run('install-wide');
      const dashboard = createDashboard(db, {
        name: 'Site one',
        site_scope: '1',
        layout: '{}',
        template: null,
        updated_at: 0,
      });
      insertShareToken(db, {
        token_hash: new Uint8Array(32),
        dashboard_id: dashboard.id,
        created_at: 0,
      });
      writeAlertRules(db, [
        { site: 1, metric: 'pageviews', condition: 'above', threshold: 10, window: 'day' },
        { site: 2, metric: 'pageviews', condition: 'above', threshold: 10, window: 'day' },
      ]);
      return dashboard.id;
    });
  }

  it('tombstones, clears every site-scoped object, and purges the data', async () => {
    const session = await login();
    seedSiteObjects();

    const res = await mutate(session, 'DELETE', '/api/admin/sites/1', undefined);
    expect(res.status).toBe(200);

    // Immediately invisible: directory, getSite (ingest's gate), query scope.
    expect(listSites(db).map((site) => site.id)).toEqual([2]);
    expect(getSite(db, 1)).toBeUndefined();

    // Config rows fell inline, in the same transaction as the tombstone.
    const count = (sql: string): number => stmt(db, sql).pluck().get() as number;
    expect(count('SELECT COUNT(*) FROM goals')).toBe(0);
    expect(count('SELECT COUNT(*) FROM campaigns')).toBe(0);
    expect(count('SELECT COUNT(*) FROM campaign_aliases')).toBe(0);
    expect(count('SELECT COUNT(*) FROM prop_keys')).toBe(0);
    // The site's annotation went; the install-wide one stays.
    expect(count('SELECT COUNT(*) FROM annotations')).toBe(1);
    // The scoped dashboard and its share token went together.
    expect(count('SELECT COUNT(*) FROM dashboards')).toBe(0);
    expect(count('SELECT COUNT(*) FROM share_tokens')).toBe(0);
    // Only the other site's alert rule survives.
    expect(readAlertRules(db).map((rule) => rule.site)).toEqual([2]);

    // The route kicked the chunked purge; joining it proves the bulk data went.
    await runSitePurges(db);
    expect(count('SELECT COUNT(*) FROM events WHERE site_id = 1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM events WHERE site_id = 2')).toBe(1);
    expect(count('SELECT COUNT(*) FROM sites WHERE id = 1')).toBe(0);
  });

  it('404s an unknown site and a repeat delete', async () => {
    const session = await login();
    expect((await mutate(session, 'DELETE', '/api/admin/sites/99', undefined)).status).toBe(404);
    expect((await mutate(session, 'DELETE', '/api/admin/sites/1', undefined)).status).toBe(200);
    await runSitePurges(db);
    expect((await mutate(session, 'DELETE', '/api/admin/sites/1', undefined)).status).toBe(404);
    expect((await mutate(session, 'DELETE', '/api/admin/sites/nope', undefined)).status).toBe(400);
  });
});

describe('data settings (docs/02 § Background jobs)', () => {
  it('reads the defaults: keep forever, backups off, keep 7', async () => {
    const { cookie } = await login();
    const res = await app.request('/api/admin/data-settings', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retentionDays: null, backupDir: null, backupKeep: 7 });
  });

  it('stores a full replacement and clears settings back to null', async () => {
    const session = await login();
    const put = await mutate(session, 'PUT', '/api/admin/data-settings', {
      retentionDays: 90,
      backupDir: '/backups',
      backupKeep: 3,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ retentionDays: 90, backupDir: '/backups', backupKeep: 3 });

    const cleared = await mutate(session, 'PUT', '/api/admin/data-settings', {
      retentionDays: null,
      backupDir: null,
      backupKeep: 7,
    });
    expect(await cleared.json()).toEqual({ retentionDays: null, backupDir: null, backupKeep: 7 });
    expect(getSetting(db, 'retention_days')).toBeUndefined();
    expect(getSetting(db, 'backup_dir')).toBeUndefined();
    expect(getSetting(db, 'backup_keep')).toBeUndefined();
  });

  it('400s an out-of-vocabulary body', async () => {
    const session = await login();
    const res = await mutate(session, 'PUT', '/api/admin/data-settings', {
      retentionDays: -1,
      backupDir: null,
      backupKeep: 7,
    });
    expect(res.status).toBe(400);
  });
});
