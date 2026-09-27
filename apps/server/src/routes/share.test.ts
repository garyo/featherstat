import { createHash } from 'node:crypto';
import { DASHBOARD_LAYOUT_VERSION, SharePayloadSchema } from '@featherstat/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, openTestDb, session, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import {
  createGoal,
  type Db,
  insertEvents,
  updateGoal,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { executeQueryRequest } from '../query/executor.ts';
import { createAdminRoutes } from './admin.ts';
import { createDashboardRoutes } from './dashboards.ts';
import { createShareRoutes } from './share.ts';

const PASSWORD = 'a-decent-password';

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
    { id: 'w-title', viz: 'feed', w: 12, h: 2 }, // a widget with no query contributes nothing
  ],
};

/** As the pre-f47d1e5 server stored it: no version, no `engaged_sessions`. */
const PRE_VERSIONING_LAYOUT = {
  name: 'Overview',
  site: 1,
  grid: [
    {
      id: 'w-kpis',
      viz: 'kpi-row',
      w: 12,
      h: 1,
      options: { tiles: ['visitors', 'avg_engagement'] },
      query: { id: 'kpis', metrics: ['visitors', 'visits', 'engaged_ms'] },
    },
  ],
};

/** Inside the default 30d share range of the seeded 2023-11-14 fixture data. */
const SEEDED_NOW = Date.UTC(2023, 10, 14, 17);

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;
let clock: number;

beforeEach(async () => {
  db = openTestDb(2);
  withWriteTransaction(db, () => {
    insertEvents(db, [event()]);
    upsertSessions(db, [session()]);
  });
  clock = T0;
  auth = createAuth(db, { now: () => clock, env: {}, log: () => {} });
  app = new Hono<AuthEnv>()
    .route('/', createAdminRoutes(db, auth))
    .route('/', createDashboardRoutes(db, auth))
    .route('/', createShareRoutes(db, auth));
  await auth.setPassword(PASSWORD);
});

afterEach(() => {
  vi.useRealTimers();
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

/** Creates the LAYOUT dashboard (id 1) and mints a share token for it. */
async function mintShare(session: Session, layout: unknown = LAYOUT): Promise<string> {
  const created = await mutate(session, 'POST', '/api/admin/dashboards', layout);
  expect(created.status).toBe(201);
  const minted = await mutate(session, 'POST', '/api/admin/dashboards/1/share');
  expect(minted.status).toBe(201);
  const { token } = (await minted.json()) as { token: string };
  return token;
}

describe('minting', () => {
  it('returns the token once and stores only its sha256', async () => {
    const token = await mintShare(await login());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = db
      .prepare('SELECT token_hash, dashboard_id, created_at, revoked_at FROM share_tokens')
      .all() as Array<{ token_hash: Buffer; dashboard_id: number; revoked_at: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash.equals(createHash('sha256').update(token).digest())).toBe(true);
    expect(rows[0]).toMatchObject({ dashboard_id: 1, revoked_at: null });
    // The raw token appears nowhere in the database image.
    expect(db.serialize().includes(token)).toBe(false);
  });

  it('404s an unknown dashboard and 401s without a session', async () => {
    const session = await login();
    expect((await mutate(session, 'POST', '/api/admin/dashboards/9/share')).status).toBe(404);
    const anonymous = await app.request('/api/admin/dashboards/1/share', { method: 'POST' });
    expect(anonymous.status).toBe(401);
  });
});

describe('GET /share/:token', () => {
  it('answers the stored dashboard and its own batch, with an ETag', async () => {
    vi.useFakeTimers({ now: SEEDED_NOW, toFake: ['Date'] });
    const token = await mintShare(await login());

    const res = await app.request(`/share/${token}`);
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');

    const view = SharePayloadSchema.parse(await res.json());
    expect(view.dashboard).toMatchObject({ name: 'Overview', site: 1 });
    expect(view.dashboard.grid).toHaveLength(2);
    // The SAME batch the in-app view runs: the widget's query, its derived
    // sparkline companion, and the previous-period compare rows.
    expect(Object.keys(view.results).sort()).toEqual(['kpis', 'kpis~spark']);
    expect(view.results.kpis).toMatchObject({
      rows: [{ visitors: 1, pageviews: 1 }],
      compare: expect.any(Array),
      ms: expect.any(Number),
    });
    // The global write counter must not ride readable in a public body.
    expect(view.meta.dataVersion).toBe(0);
    // The resolved window does ride along, and it is the SAME one the in-app
    // dashboard gets. A share page has no site directory, so before this it fell
    // back to the data extent and the two screens showed different windows
    // through identical widget code.
    expect(view.meta.windows).toEqual([
      { siteId: 1, timezone: 'America/New_York', from: '2023-10-16', to: '2023-11-14' },
    ]);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');

    // Revalidation is free, exactly like /api/query.
    const revalidated = await app.request(`/share/${token}`, {
      headers: { 'if-none-match': etag as string },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
  });

  it('accepts only whitelisted range presets', async () => {
    const token = await mintShare(await login());
    expect((await app.request(`/share/${token}?range=7d`)).status).toBe(200);
    // The rolling preset resolves a sub-day window here too, through this
    // route's own copy of the ETag construction.
    expect((await app.request(`/share/${token}?range=24h`)).status).toBe(200);
    expect((await app.request(`/share/${token}?range=yesterday`)).status).toBe(400);
    expect((await app.request(`/share/${token}?range=2023-01-01,2023-02-01`)).status).toBe(400);
  });

  it('500s a stored layout that no longer validates, without executing it', async () => {
    const token = await mintShare(await login());
    // Bypass the API (which would 400): a migration bug or manual edit lands here.
    db.prepare('UPDATE dashboards SET layout = ? WHERE id = 1').run('{"not":"a dashboard"}');
    const res = await app.request(`/share/${token}`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain('not'); // no internals, no layout echo
  });

  it('upgrades a layout stored before the metric vocabulary changed, then executes it', async () => {
    vi.useFakeTimers({ now: SEEDED_NOW, toFake: ['Date'] });
    const token = await mintShare(await login());
    // The row a pre-f47d1e5 build stored: no version, and an avg-engagement
    // tile whose query never names the denominator it divides by.
    db.prepare('UPDATE dashboards SET layout = ? WHERE id = 1').run(
      JSON.stringify(PRE_VERSIONING_LAYOUT),
    );

    const res = await app.request(`/share/${token}`);
    expect(res.status).toBe(200);
    const view = SharePayloadSchema.parse(await res.json());
    expect(view.dashboard.version).toBe(DASHBOARD_LAYOUT_VERSION);

    // The proof is in what the server actually ran: the answered row carries the
    // upgraded metric, so the shared tile has its denominator.
    const result = view.results.kpis;
    expect(result !== undefined && 'rows' in result ? result.rows[0] : undefined).toHaveProperty(
      'engaged_sessions',
    );

    // A read-only link stays read-only: the row is untouched.
    const stored = db.prepare('SELECT layout FROM dashboards WHERE id = 1').get() as {
      layout: string;
    };
    expect(JSON.parse(stored.layout)).toEqual(PRE_VERSIONING_LAYOUT);
  });

  it('rate-limits executed batches per IP, while 304 revalidations stay free', async () => {
    vi.useFakeTimers({ now: SEEDED_NOW, toFake: ['Date'] });
    const token = await mintShare(await login());
    const first = await app.request(`/share/${token}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag') as string;

    let limited: Response | undefined;
    for (let i = 0; i < 40; i++) {
      const res = await app.request(`/share/${token}`);
      if (res.status === 429) {
        limited = res;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).toBeDefined();
    expect(limited?.headers.get('retry-after')).toBe('60');

    // Conditional revalidation is not an executed batch — never throttled.
    const revalidated = await app.request(`/share/${token}`, {
      headers: { 'if-none-match': etag },
    });
    expect(revalidated.status).toBe(304);

    // The window slides: a minute later the budget is back.
    clock += 61_000;
    expect((await app.request(`/share/${token}`)).status).toBe(200);
  });

  it('404s unknown, malformed and revoked tokens identically', async () => {
    const session = await login();
    const token = await mintShare(session);

    const unknown = await app.request(`/share/${'A'.repeat(43)}`);
    expect(unknown.status).toBe(404);
    const malformed = await app.request('/share/not-a-token');
    expect(malformed.status).toBe(404);

    const revoked = await mutate(session, 'DELETE', '/api/admin/dashboards/1/share');
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: 1 });

    const afterRevoke = await app.request(`/share/${token}`);
    expect(afterRevoke.status).toBe(404);
    expect(await afterRevoke.json()).toEqual(await unknown.json());
  });

  it('never accepts a client-supplied QueryRequest', async () => {
    const token = await mintShare(await login());
    const queryRequest = {
      site: 'all',
      range: { preset: '90d' },
      queries: [{ id: 'exfil', metrics: ['visitors'], dim: 'path' }],
    };
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request(`/share/${token}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(queryRequest),
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow'), method).toBe('GET, HEAD');
    }
    // The GET answer is the stored batch: the layout's own query ids, nothing else.
    const res = await app.request(`/share/${token}`);
    const view = SharePayloadSchema.parse(await res.json());
    expect(Object.keys(view.results).sort()).toEqual(['kpis', 'kpis~spark']);
  });

  it('dies with its dashboard', async () => {
    const session = await login();
    const token = await mintShare(session);
    expect((await app.request(`/share/${token}`)).status).toBe(200);
    expect((await mutate(session, 'DELETE', '/api/admin/dashboards/1')).status).toBe(200);
    expect((await app.request(`/share/${token}`)).status).toBe(404);
  });

  it('changes its ETag when the layout is edited', async () => {
    vi.useFakeTimers({ now: SEEDED_NOW, toFake: ['Date'] });
    const session = await login();
    const token = await mintShare(session);
    const before = (await app.request(`/share/${token}`)).headers.get('etag');

    clock += 60_000;
    const edited = await mutate(session, 'PUT', '/api/admin/dashboards/1', {
      ...LAYOUT,
      name: 'Renamed',
    });
    expect(edited.status).toBe(200);

    const after = await app.request(`/share/${token}`, {
      headers: { 'if-none-match': before as string },
    });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(before);
  });
});

describe('execution', () => {
  const pathFilter = (value?: string) =>
    JSON.stringify([
      value === undefined ? { dim: 'path', op: 'is_null' } : { dim: 'path', op: 'eq', value },
    ]);

  /**
   * A shared dashboard's goal widget must answer like the in-app one: the
   * share route resolves goal definitions exactly as /api/query does, and
   * hashes them, so a goal edit expires the link's cached answer.
   */
  it('answers goal widgets and expires its ETag when a goal is edited', async () => {
    vi.useFakeTimers({ now: SEEDED_NOW, toFake: ['Date'] });
    const goal = withWriteTransaction(db, () =>
      createGoal(
        db,
        { site_id: 1, name: 'Landed', filters: pathFilter(), value_expr: null, target: null },
        T0,
      ),
    );
    const conversions = `goal:${goal.id}:conversions`;
    const token = await mintShare(await login(), {
      name: 'Goals',
      site: 1,
      grid: [
        {
          id: 'w-goal',
          viz: 'bar-list',
          w: 6,
          h: 2,
          query: { id: 'goal', metrics: [conversions], dim: 'device_type' },
        },
      ],
    });

    const res = await app.request(`/share/${token}`);
    expect(res.status).toBe(200);
    const view = SharePayloadSchema.parse(await res.json());
    expect(view.results.goal).toMatchObject({ rows: [{ [conversions]: 1 }] });
    const before = res.headers.get('etag') as string;

    withWriteTransaction(db, () =>
      updateGoal(
        db,
        goal.id,
        { name: 'Landed', filters: pathFilter('/never'), value_expr: null, target: null },
        T0 + 1,
      ),
    );
    const after = await app.request(`/share/${token}`, { headers: { 'if-none-match': before } });
    expect(after.status).toBe(200);
    expect(SharePayloadSchema.parse(await after.json()).results.goal).toMatchObject({ rows: [] });
  });

  it('runs through the injected executor — the worker pool in production', async () => {
    vi.useFakeTimers({ now: SEEDED_NOW, toFake: ['Date'] });
    const execute = vi.fn((request: Parameters<typeof executeQueryRequest>[1], now: number) =>
      executeQueryRequest(db, request, { now }),
    );
    app = new Hono<AuthEnv>()
      .route('/', createAdminRoutes(db, auth))
      .route('/', createDashboardRoutes(db, auth))
      .route('/', createShareRoutes(db, auth, { execute }));
    const token = await mintShare(await login());
    expect((await app.request(`/share/${token}`)).status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('revocation', () => {
  it('revokes every live token of the dashboard', async () => {
    const session = await login();
    const first = await mintShare(session);
    const minted = await mutate(session, 'POST', '/api/admin/dashboards/1/share');
    const { token: second } = (await minted.json()) as { token: string };

    const revoked = await mutate(session, 'DELETE', '/api/admin/dashboards/1/share');
    expect(await revoked.json()).toEqual({ revoked: 2 });
    expect((await app.request(`/share/${first}`)).status).toBe(404);
    expect((await app.request(`/share/${second}`)).status).toBe(404);
    // A second sweep has nothing left to revoke.
    const again = await mutate(session, 'DELETE', '/api/admin/dashboards/1/share');
    expect(await again.json()).toEqual({ revoked: 0 });
  });

  it('404s revocation for an unknown dashboard', async () => {
    const session = await login();
    expect((await mutate(session, 'DELETE', '/api/admin/dashboards/9/share')).status).toBe(404);
  });
});
