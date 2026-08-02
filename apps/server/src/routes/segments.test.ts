import type { SegmentInfo } from '@featherstat/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import { type Db, withWriteTransaction } from '../db/index.ts';
import { createAdminRoutes } from './admin.ts';
import { createSegmentRoutes } from './segments.ts';

const PASSWORD = 'a-decent-password';

const US_FILTER = { dim: 'country', op: 'eq', value: 'US' };

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;

beforeEach(async () => {
  db = openTestDb();
  auth = createAuth(db, { now: () => T0, env: {}, log: () => {} });
  app = new Hono<AuthEnv>()
    .route('/', createAdminRoutes(db, auth))
    .route('/', createSegmentRoutes(db, auth));
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
  it('401s every admin segment route without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/segments'],
      ['POST', '/api/admin/segments'],
      ['PUT', '/api/admin/segments/1'],
      ['DELETE', '/api/admin/segments/1'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('403s mutations without the CSRF token', async () => {
    const { cookie } = await login();
    const res = await app.request('/api/admin/segments', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'US', filter: US_FILTER }),
    });
    expect(res.status).toBe(403);
  });
});

describe('segments CRUD', () => {
  it('creates, lists, updates and deletes a segment', async () => {
    const session = await login();
    const created = await mutate(session, 'POST', '/api/admin/segments', {
      name: 'US traffic',
      filter: US_FILTER,
    });
    expect(created.status).toBe(201);
    const info = (await created.json()) as SegmentInfo;
    expect(info).toEqual({ id: 1, name: 'US traffic', filter: US_FILTER, updatedAt: T0 });

    const listed = await app.request('/api/segments');
    expect((await listed.json()) as SegmentInfo[]).toEqual([info]);

    const updated = await mutate(session, 'PUT', '/api/admin/segments/1', {
      name: 'Search from the US',
      filter: { all: [US_FILTER, { dim: 'ref_type', op: 'eq', value: 'search' }] },
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as SegmentInfo).name).toBe('Search from the US');

    const deleted = await mutate(session, 'DELETE', '/api/admin/segments/1');
    expect(deleted.status).toBe(200);
    expect((await (await app.request('/api/segments')).json()) as SegmentInfo[]).toEqual([]);
  });

  it('400s a stored-grammar violation: a segment may not reference a segment', async () => {
    const session = await login();
    const res = await mutate(session, 'POST', '/api/admin/segments', {
      name: 'cyclic',
      filter: { all: [US_FILTER, { segment: 1 }] },
    });
    expect(res.status).toBe(400);
  });

  it('409s a duplicate name', async () => {
    const session = await login();
    await mutate(session, 'POST', '/api/admin/segments', { name: 'US', filter: US_FILTER });
    const dup = await mutate(session, 'POST', '/api/admin/segments', {
      name: 'US',
      filter: US_FILTER,
    });
    expect(dup.status).toBe(409);
  });

  it('404s unknown ids and 400s malformed ones', async () => {
    const session = await login();
    expect(
      (await mutate(session, 'PUT', '/api/admin/segments/7', { name: 'x', filter: US_FILTER }))
        .status,
    ).toBe(404);
    expect((await mutate(session, 'DELETE', '/api/admin/segments/7')).status).toBe(404);
    expect((await mutate(session, 'DELETE', '/api/admin/segments/zero')).status).toBe(400);
  });

  it('omits (and logs) a stored row that no longer parses — fail closed, not broken', async () => {
    const session = await login();
    await mutate(session, 'POST', '/api/admin/segments', { name: 'ok', filter: US_FILTER });
    withWriteTransaction(db, () => {
      db.prepare("UPDATE segments SET filter = '{\"nonsense\":1}' WHERE name = 'ok'").run();
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const listed = await app.request('/api/segments');
      expect((await listed.json()) as SegmentInfo[]).toEqual([]);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
