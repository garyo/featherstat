import type { CampaignAlias, CampaignInfo } from '@featherstat/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { event, openTestDb, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import { type Db, insertEvents, withWriteTransaction } from '../db/index.ts';
import { runCampaignBackfill } from '../jobs/campaign-backfill.ts';
import { AliasCache } from '../pipeline/campaigns.ts';
import { createAdminRoutes } from './admin.ts';
import { createCampaignRoutes } from './campaigns.ts';

const PASSWORD = 'a-decent-password';

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;
let aliasCache: AliasCache;

beforeEach(async () => {
  db = openTestDb();
  auth = createAuth(db, { now: () => T0, env: {}, log: () => {} });
  aliasCache = new AliasCache(db);
  app = new Hono<AuthEnv>()
    .route('/', createAdminRoutes(db, auth))
    .route('/', createCampaignRoutes(db, auth, { aliasCache }));
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

interface Session {
  cookie: string;
  csrf: string;
}

async function login(): Promise<Session> {
  const res = await app.request('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie: cookiesOf(res), csrf };
}

async function mutate(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const CAMPAIGN = {
  name: 'Spring Launch',
  startsAt: '2026-07-01',
  endsAt: '2026-07-31',
};

describe('auth boundary', () => {
  it('401s every admin campaign route without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/campaign-aliases?site=1'],
      ['PUT', '/api/admin/campaign-aliases?site=1'],
      ['GET', '/api/admin/campaigns?site=1'],
      ['POST', '/api/admin/campaigns?site=1'],
      ['PUT', '/api/admin/campaigns/1'],
      ['DELETE', '/api/admin/campaigns/1'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('campaign aliases', () => {
  it('replaces the list, invalidates the cache, and enqueues the backfill', async () => {
    withWriteTransaction(db, () => {
      insertEvents(db, [event({ utm_source: 'em' })]);
    });
    expect(aliasCache.resolve(1, 'source', 'em')).toBeUndefined(); // cache loaded empty
    const session = await login();
    const res = await mutate(session, 'PUT', '/api/admin/campaign-aliases?site=1', [
      { field: 'source', alias: ' EM ', canonical: 'Email' },
    ]);
    expect(res.status).toBe(200);
    // The schema canonicalizes what it stores — an uncanonical alias never matches.
    expect((await res.json()) as CampaignAlias[]).toEqual([
      { field: 'source', alias: 'em', canonical: 'email' },
    ]);
    expect(aliasCache.resolve(1, 'source', 'em')).toBe('email'); // invalidated + reloaded
    // The watermark rode the same transaction; the route kicked the drain and
    // this either joins the in-flight run or finds it already done.
    await runCampaignBackfill(db);
    const row = db.prepare('SELECT utm_source, utm_source_raw FROM events').get();
    expect(row).toEqual({ utm_source: 'email', utm_source_raw: 'em' });
  });

  it('accepts site 0 (install-wide) and lists what it stored', async () => {
    const session = await login();
    const put = await mutate(session, 'PUT', '/api/admin/campaign-aliases?site=0', [
      { field: 'medium', alias: 'paid', canonical: 'cpc' },
    ]);
    expect(put.status).toBe(200);
    const res = await app.request('/api/admin/campaign-aliases?site=0', {
      headers: { cookie: session.cookie },
    });
    expect((await res.json()) as CampaignAlias[]).toEqual([
      { field: 'medium', alias: 'paid', canonical: 'cpc' },
    ]);
  });

  it('400s a duplicate alias and a bad site', async () => {
    const session = await login();
    const dup = await mutate(session, 'PUT', '/api/admin/campaign-aliases?site=1', [
      { field: 'source', alias: 'a', canonical: 'b' },
      { field: 'source', alias: 'A', canonical: 'c' },
    ]);
    expect(dup.status).toBe(400);
    const bad = await mutate(session, 'PUT', '/api/admin/campaign-aliases?site=-1', []);
    expect(bad.status).toBe(400);
  });
});

describe('campaigns registry', () => {
  it('creates, lists (for any principal), updates and deletes', async () => {
    const session = await login();
    const created = await mutate(session, 'POST', '/api/admin/campaigns?site=1', CAMPAIGN);
    expect(created.status).toBe(201);
    const info = (await created.json()) as CampaignInfo;
    expect(info).toMatchObject({
      siteId: 1,
      name: 'spring launch', // canonicalized like the utm values it registers
      startsAt: '2026-07-01',
      endsAt: '2026-07-31',
      expectedSources: null,
    });

    const listed = await app.request('/api/campaigns?site=1', {
      headers: { cookie: session.cookie },
    });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as CampaignInfo[]).map((c) => c.name)).toEqual(['spring launch']);

    const updated = await mutate(session, 'PUT', `/api/admin/campaigns/${info.id}`, {
      ...CAMPAIGN,
      expectedSources: ['newsletter'],
      endsAt: null,
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()) as CampaignInfo).toMatchObject({
      expectedSources: ['newsletter'],
      endsAt: null,
    });

    const deleted = await mutate(session, 'DELETE', `/api/admin/campaigns/${info.id}`);
    expect(deleted.status).toBe(200);
    expect(
      await (await mutate(session, 'DELETE', `/api/admin/campaigns/${info.id}`)).json(),
    ).toHaveProperty('error');
  });

  it('refuses a lifespan that ends before it starts, and a duplicate name', async () => {
    const session = await login();
    const backwards = await mutate(session, 'POST', '/api/admin/campaigns?site=1', {
      name: 'x',
      startsAt: '2026-07-31',
      endsAt: '2026-07-01',
    });
    expect(backwards.status).toBe(400);
    expect((await mutate(session, 'POST', '/api/admin/campaigns?site=1', CAMPAIGN)).status).toBe(
      201,
    );
    expect((await mutate(session, 'POST', '/api/admin/campaigns?site=1', CAMPAIGN)).status).toBe(
      409,
    );
  });
});
