import { MAX_WIDGETS_PER_DASHBOARD } from '@analytics/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import { type Db, listDashboards } from '../db/index.ts';
import { createAdminRoutes } from './admin.ts';
import { createDashboardRoutes, type DashboardDetail, type DashboardInfo } from './dashboards.ts';

const PASSWORD = 'a-decent-password';

/** A valid two-widget layout; the schema normalizes widgets with `options: {}`. */
const LAYOUT = {
  name: 'Overview',
  site: 1,
  grid: [
    {
      id: 'w-kpis',
      viz: 'kpi-row',
      w: 12,
      h: 1,
      query: { id: 'kpis', metrics: ['visitors', 'pageviews'] },
    },
    {
      id: 'w-pages',
      viz: 'bar-list',
      w: 6,
      h: 2,
      title: 'Top pages',
      query: { id: 'pages', metrics: ['pageviews'], dim: 'path', limit: 10 },
    },
  ],
};

function widgets(count: number): object[] {
  return Array.from({ length: count }, (_, i) => ({ id: `w${i}`, viz: 'kpi-row', w: 1, h: 1 }));
}

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;
let clock: number;

beforeEach(async () => {
  db = openTestDb(2);
  clock = T0;
  auth = createAuth(db, { now: () => clock, env: {}, log: () => {} });
  app = new Hono<AuthEnv>()
    .route('/', createAdminRoutes(db, auth))
    .route('/', createDashboardRoutes(db, auth));
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
  it('401s every dashboard route without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/dashboards'],
      ['GET', '/api/admin/dashboards/1'],
      ['POST', '/api/admin/dashboards'],
      ['PUT', '/api/admin/dashboards/1'],
      ['DELETE', '/api/admin/dashboards/1'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('403s mutations without the CSRF token', async () => {
    const { cookie } = await login();
    const res = await app.request('/api/admin/dashboards', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(LAYOUT),
    });
    expect(res.status).toBe(403);
  });
});

describe('dashboards CRUD', () => {
  it('creates, gets and lists a dashboard', async () => {
    const session = await login();
    const created = await mutate(session, 'POST', '/api/admin/dashboards', LAYOUT);
    expect(created.status).toBe(201);
    const detail = (await created.json()) as DashboardDetail;
    expect(detail).toMatchObject({ id: 1, name: 'Overview', site: 1, updatedAt: T0 });
    expect(detail.layout.grid).toHaveLength(2);
    expect(detail.layout.grid[0]).toMatchObject({ id: 'w-kpis', options: {} });

    const got = await app.request('/api/admin/dashboards/1', {
      headers: { cookie: session.cookie },
    });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(detail);

    const list = await app.request('/api/admin/dashboards', {
      headers: { cookie: session.cookie },
    });
    const rows = (await list.json()) as DashboardInfo[];
    expect(rows).toEqual([{ id: 1, name: 'Overview', site: 1, updatedAt: T0 }]);
  });

  it('rejects invalid layouts with a 400 and stores nothing', async () => {
    const session = await login();
    for (const body of [
      {}, // no name/site/grid
      { ...LAYOUT, name: '' },
      { ...LAYOUT, site: 0 },
      { ...LAYOUT, grid: [{ id: 'w', viz: 'pie-chart-3d', w: 1, h: 1 }] }, // unknown viz
      { ...LAYOUT, grid: [{ id: 'w', viz: 'kpi-row', w: 13, h: 1 }] }, // off the 12-col grid
      { ...LAYOUT, grid: [{ id: 'w', viz: 'kpi-row', w: 1, h: 1, query: { id: 'q' } }] }, // bad query
    ]) {
      const res = await mutate(session, 'POST', '/api/admin/dashboards', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const raw = await app.request('/api/admin/dashboards', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
        'content-type': 'application/json',
      },
      body: 'not json',
    });
    expect(raw.status).toBe(400);
    expect(listDashboards(db)).toEqual([]);
  });

  it('enforces the widget cap', async () => {
    const session = await login();
    const over = await mutate(session, 'POST', '/api/admin/dashboards', {
      ...LAYOUT,
      grid: widgets(MAX_WIDGETS_PER_DASHBOARD + 1),
    });
    expect(over.status).toBe(400);
    expect(listDashboards(db)).toEqual([]);

    const full = await mutate(session, 'POST', '/api/admin/dashboards', {
      ...LAYOUT,
      grid: widgets(MAX_WIDGETS_PER_DASHBOARD),
    });
    expect(full.status).toBe(201);
  });

  it('rejects layouts whose widgets collide on a query id', async () => {
    const session = await login();
    const res = await mutate(session, 'POST', '/api/admin/dashboards', {
      ...LAYOUT,
      grid: [
        { id: 'w1', viz: 'bar-list', w: 6, h: 2, query: { id: 'q', metrics: ['visitors'] } },
        { id: 'w2', viz: 'bar-list', w: 6, h: 2, query: { id: 'q', metrics: ['pageviews'] } },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('duplicate query id');
    expect(listDashboards(db)).toEqual([]);
  });

  it('rejects layouts whose DERIVED queries overflow the batch cap', async () => {
    // 17 kpi-rows fit the 24-widget cap, but each contributes main + sparkline:
    // 34 queries > MAX_QUERIES_PER_BATCH. The view could never fetch this.
    const session = await login();
    const grid = Array.from({ length: 17 }, (_, i) => ({
      id: `w${i}`,
      viz: 'kpi-row',
      w: 12,
      h: 1,
      query: { id: `q${i}`, metrics: ['visitors'] },
    }));
    const res = await mutate(session, 'POST', '/api/admin/dashboards', { ...LAYOUT, grid });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('at most');
    expect(listDashboards(db)).toEqual([]);
  });

  it('500s a stored layout that no longer validates instead of casting it', async () => {
    const session = await login();
    await mutate(session, 'POST', '/api/admin/dashboards', LAYOUT);
    // Schema-valid but unbatchable (duplicate query ids) counts as invalid too.
    const dupe = {
      ...LAYOUT,
      grid: [
        {
          id: 'w1',
          viz: 'bar-list',
          w: 6,
          h: 2,
          options: {},
          query: { id: 'q', metrics: ['visitors'] },
        },
        {
          id: 'w2',
          viz: 'bar-list',
          w: 6,
          h: 2,
          options: {},
          query: { id: 'q', metrics: ['visitors'] },
        },
      ],
    };
    db.prepare('UPDATE dashboards SET layout = ? WHERE id = 1').run(JSON.stringify(dupe));
    const unbatchable = await app.request('/api/admin/dashboards/1', {
      headers: { cookie: session.cookie },
    });
    expect(unbatchable.status).toBe(500);
    db.prepare('UPDATE dashboards SET layout = ? WHERE id = 1').run('{"broken":true}');
    const got = await app.request('/api/admin/dashboards/1', {
      headers: { cookie: session.cookie },
    });
    expect(got.status).toBe(500);
    // A fresh PUT repairs the row.
    expect((await mutate(session, 'PUT', '/api/admin/dashboards/1', LAYOUT)).status).toBe(200);
    const repaired = await app.request('/api/admin/dashboards/1', {
      headers: { cookie: session.cookie },
    });
    expect(repaired.status).toBe(200);
  });

  it('replaces the layout on PUT and bumps updated_at', async () => {
    const session = await login();
    await mutate(session, 'POST', '/api/admin/dashboards', LAYOUT);

    clock += 60_000;
    const replaced = await mutate(session, 'PUT', '/api/admin/dashboards/1', {
      name: 'All sites',
      site: 'all',
      grid: widgets(1),
    });
    expect(replaced.status).toBe(200);
    const detail = (await replaced.json()) as DashboardDetail;
    expect(detail).toMatchObject({ id: 1, name: 'All sites', site: 'all', updatedAt: T0 + 60_000 });
    expect(detail.layout.grid).toHaveLength(1);

    // An invalid replacement never reaches storage.
    const bad = await mutate(session, 'PUT', '/api/admin/dashboards/1', { ...LAYOUT, grid: 'no' });
    expect(bad.status).toBe(400);
    expect(listDashboards(db)[0]?.name).toBe('All sites');
  });

  it('404s unknown ids and 400s malformed ones', async () => {
    const session = await login();
    expect((await mutate(session, 'PUT', '/api/admin/dashboards/9', LAYOUT)).status).toBe(404);
    expect((await mutate(session, 'DELETE', '/api/admin/dashboards/9')).status).toBe(404);
    const got = await app.request('/api/admin/dashboards/9', {
      headers: { cookie: session.cookie },
    });
    expect(got.status).toBe(404);
    const bad = await app.request('/api/admin/dashboards/nope', {
      headers: { cookie: session.cookie },
    });
    expect(bad.status).toBe(400);
  });

  it('deletes a dashboard', async () => {
    const session = await login();
    await mutate(session, 'POST', '/api/admin/dashboards', LAYOUT);
    const res = await mutate(session, 'DELETE', '/api/admin/dashboards/1');
    expect(res.status).toBe(200);
    expect(listDashboards(db)).toEqual([]);
    const got = await app.request('/api/admin/dashboards/1', {
      headers: { cookie: session.cookie },
    });
    expect(got.status).toBe(404);
  });
});
