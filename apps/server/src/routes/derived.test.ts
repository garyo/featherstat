import type { DerivedMetricInfo } from '@featherstat/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import type { Db } from '../db/index.ts';
import { createAdminRoutes } from './admin.ts';
import { createDerivedMetricRoutes } from './derived.ts';

const PASSWORD = 'a-decent-password';

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;

beforeEach(async () => {
  db = openTestDb();
  auth = createAuth(db, { now: () => T0, env: {}, log: () => {} });
  app = new Hono<AuthEnv>()
    .route('/', createAdminRoutes(db, auth))
    .route('/', createDerivedMetricRoutes(db, auth));
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

describe('auth boundary', () => {
  it('401s every admin derived-metric route without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/derived-metrics'],
      ['POST', '/api/admin/derived-metrics'],
      ['PUT', '/api/admin/derived-metrics/1'],
      ['DELETE', '/api/admin/derived-metrics/1'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('derived metrics CRUD', () => {
  it('creates, lists, updates and deletes a derived metric', async () => {
    const session = await login();
    const created = await mutate(session, 'POST', '/api/admin/derived-metrics', {
      name: 'events_per_visit',
      expr: 'events / visits',
    });
    expect(created.status).toBe(201);
    const info = (await created.json()) as DerivedMetricInfo;
    expect(info).toEqual({
      id: 1,
      name: 'events_per_visit',
      expr: 'events / visits',
      updatedAt: T0,
    });

    const listed = await app.request('/api/derived-metrics');
    expect((await listed.json()) as DerivedMetricInfo[]).toEqual([info]);

    const updated = await mutate(session, 'PUT', '/api/admin/derived-metrics/1', {
      name: 'events_per_visit',
      expr: 'events / engaged_sessions',
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as DerivedMetricInfo).expr).toBe('events / engaged_sessions');

    const deleted = await mutate(session, 'DELETE', '/api/admin/derived-metrics/1');
    expect(deleted.status).toBe(200);
    expect(
      (await (await app.request('/api/derived-metrics')).json()) as DerivedMetricInfo[],
    ).toEqual([]);
  });

  it('400s a name that shadows a built-in and an expression outside the grammar', async () => {
    const session = await login();
    const shadow = await mutate(session, 'POST', '/api/admin/derived-metrics', {
      name: 'visitors',
      expr: 'events / visits',
    });
    expect(shadow.status).toBe(400);
    const junk = await mutate(session, 'POST', '/api/admin/derived-metrics', {
      name: 'ok',
      expr: 'DROP TABLE events',
    });
    expect(junk.status).toBe(400);
  });

  it('409s a duplicate name', async () => {
    const session = await login();
    await mutate(session, 'POST', '/api/admin/derived-metrics', { name: 'x', expr: 'visits' });
    const dup = await mutate(session, 'POST', '/api/admin/derived-metrics', {
      name: 'x',
      expr: 'pageviews',
    });
    expect(dup.status).toBe(409);
  });

  it('404s unknown ids and 400s malformed ones', async () => {
    const session = await login();
    expect(
      (await mutate(session, 'PUT', '/api/admin/derived-metrics/7', { name: 'x', expr: 'visits' }))
        .status,
    ).toBe(404);
    expect((await mutate(session, 'DELETE', '/api/admin/derived-metrics/7')).status).toBe(404);
    expect((await mutate(session, 'DELETE', '/api/admin/derived-metrics/x')).status).toBe(400);
  });
});
