import type { SiteInfo } from '@analytics/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { event, openTestDb, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import {
  type Db,
  getSite,
  incrementBotDrops,
  insertEvents,
  withWriteTransaction,
} from '../db/index.ts';
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
