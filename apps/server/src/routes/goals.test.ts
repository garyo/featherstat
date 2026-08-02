import type { GoalInfo } from '@featherstat/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import { type Db, getGoal } from '../db/index.ts';
import { createAdminRoutes } from './admin.ts';
import { createGoalRoutes } from './goals.ts';

const PASSWORD = 'a-decent-password';

const SIGNUP = {
  name: 'Signed up',
  filters: [{ dim: 'path', op: 'eq', value: '/signup' }],
};

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;

beforeEach(async () => {
  db = openTestDb();
  auth = createAuth(db, { now: () => T0, env: {}, log: () => {} });
  app = new Hono<AuthEnv>()
    .route('/', createAdminRoutes(db, auth))
    .route('/', createGoalRoutes(db, auth));
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
  it('401s every admin goal route without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/goals?site=1'],
      ['POST', '/api/admin/goals?site=1'],
      ['PUT', '/api/admin/goals/1'],
      ['DELETE', '/api/admin/goals/1'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('goal CRUD', () => {
  it('creates, lists, updates and deletes', async () => {
    const session = await login();
    const created = await mutate(session, 'POST', '/api/admin/goals?site=1', {
      ...SIGNUP,
      valueExpr: { fixed: 5 },
      target: 100,
    });
    expect(created.status).toBe(201);
    const info = (await created.json()) as GoalInfo;
    expect(info).toMatchObject({
      siteId: 1,
      name: 'Signed up',
      valueExpr: { fixed: 5 },
      target: 100,
    });
    expect(getGoal(db, info.id)?.value_expr).toBe('fixed:5');

    const listed = await app.request('/api/goals?site=1', { headers: { cookie: session.cookie } });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as GoalInfo[]).map((goal) => goal.name)).toEqual(['Signed up']);

    const updated = await mutate(session, 'PUT', `/api/admin/goals/${info.id}`, {
      ...SIGNUP,
      valueExpr: 'event_value',
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()) as GoalInfo).toMatchObject({
      valueExpr: 'event_value',
      target: null,
    });

    expect((await mutate(session, 'DELETE', `/api/admin/goals/${info.id}`)).status).toBe(200);
    expect((await mutate(session, 'DELETE', `/api/admin/goals/${info.id}`)).status).toBe(404);
  });

  it('400s an invalid filter tree and an empty one', async () => {
    const session = await login();
    const badDim = await mutate(session, 'POST', '/api/admin/goals?site=1', {
      name: 'x',
      filters: [{ dim: 'no_such_dim', op: 'eq', value: 'y' }],
    });
    expect(badDim.status).toBe(400);
    const empty = await mutate(session, 'POST', '/api/admin/goals?site=1', {
      name: 'x',
      filters: [],
    });
    expect(empty.status).toBe(400);
    // A segment ref cannot be stored in a goal — the schema has no such node.
    const segmentRef = await mutate(session, 'POST', '/api/admin/goals?site=1', {
      name: 'x',
      filters: [{ segment: 1 }],
    });
    expect(segmentRef.status).toBe(400);
  });

  it('scopes goals per site and enforces the unique name', async () => {
    const session = await login();
    expect((await mutate(session, 'POST', '/api/admin/goals?site=1', SIGNUP)).status).toBe(201);
    expect((await mutate(session, 'POST', '/api/admin/goals?site=1', SIGNUP)).status).toBe(409);
    const other = await app.request('/api/goals?site=2', { headers: { cookie: session.cookie } });
    expect((await other.json()) as GoalInfo[]).toEqual([]);
  });
});
