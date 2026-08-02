import type { AlertRule } from '@featherstat/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import type { Db } from '../db/index.ts';
import { readAlertRules } from '../jobs/alerts.ts';
import { createAdminRoutes } from './admin.ts';
import { createAlertRoutes } from './alerts.ts';

const PASSWORD = 'a-decent-password';

const RULE: AlertRule = {
  site: 1,
  metric: 'visits',
  condition: 'above',
  threshold: 100,
  window: 'day',
};

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;

beforeEach(async () => {
  db = openTestDb();
  auth = createAuth(db, { now: () => T0, env: {}, log: () => {} });
  app = new Hono<AuthEnv>()
    .route('/', createAdminRoutes(db, auth))
    .route('/', createAlertRoutes(db, auth));
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

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie: cookiesOf(res), csrf };
}

async function put(who: { cookie: string; csrf: string }, body: unknown): Promise<Response> {
  return await app.request('/api/admin/alerts', {
    method: 'PUT',
    headers: {
      cookie: who.cookie,
      'x-csrf-token': who.csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('/api/admin/alerts', () => {
  it('sits behind the admin wall', async () => {
    expect((await app.request('/api/admin/alerts')).status).toBe(401);
    expect((await app.request('/api/admin/alerts', { method: 'PUT' })).status).toBe(401);
  });

  it('round-trips the rule list as one settings row', async () => {
    const who = await login();
    const empty = await app.request('/api/admin/alerts', { headers: { cookie: who.cookie } });
    expect(await empty.json()).toEqual({ rules: [] });

    const saved = await put(who, { rules: [RULE] });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ rules: [RULE] });
    expect(readAlertRules(db)).toEqual([RULE]);
  });

  it('refuses invalid rules and unknown sites', async () => {
    const who = await login();
    const invalid = await put(who, { rules: [{ ...RULE, condition: 'sideways' }] });
    expect(invalid.status).toBe(400);
    const halfScoped = await put(who, { rules: [{ ...RULE, dim: 'country' }] });
    expect(halfScoped.status).toBe(400); // dim without value
    const ghost = await put(who, { rules: [{ ...RULE, site: 99 }] });
    expect(ghost.status).toBe(404);
    expect(readAlertRules(db)).toEqual([]);
  });
});
