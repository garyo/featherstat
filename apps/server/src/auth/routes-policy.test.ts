import type {
  ApiTokenMinted,
  MagicLinkMinted,
  UserInviteMinted,
  ViewerInfo,
} from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { type Db, withWriteTransaction } from '../db/index.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';
import { createSecuredApp, type SecuredApp } from './app.ts';
import { serializeSiteScope } from './principal.ts';
import { isManagerRoute } from './routes-policy.ts';
import { ensureAuthSecret, issueSession } from './session.ts';

/**
 * The authorization split (docs/04 § 5): the admin wall dispatches on the
 * routes-policy classification, and this file is its pinned matrix — every
 * admin route family × {admin, user-in-scope, user-out-of-scope, viewer,
 * anonymous}. The wall half proves the classification (403 vs not-403); the
 * scoping half proves the handlers' object checks (404 indistinguishable
 * from nonexistent, 'all' admin-only, minted grants bounded by the minter).
 */

const PASSWORD = 'a-decent-password';
const SETUP_TOKEN = 'test-setup-token';

let db: Db;
let clock: number;
let secured: SecuredApp;
let pipeline: Pipeline;

beforeEach(() => {
  db = openTestDb(2); // sites 1 ('one.test') and 2 ('two.test')
  clock = T0;
  pipeline = createPipeline(db);
  secured = createSecuredApp({
    db,
    sink: pipeline.sink,
    pipeline,
    auth: { now: () => clock, env: {}, setupToken: SETUP_TOKEN },
  });
});

afterEach(() => {
  pipeline.shutdown();
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

async function adminSession(): Promise<Session> {
  const setup = await secured.app.request('/api/admin/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, setupToken: SETUP_TOKEN }),
  });
  const res =
    setup.status === 200
      ? setup
      : await secured.app.request('/api/admin/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: PASSWORD }),
        });
  expect(res.status).toBe(200);
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie: cookiesOf(res), csrf };
}

/** A user owning `sites`, signed in — created via the API so the row is real. */
async function userSession(sites: number[], email = 'owner@example.com'): Promise<Session> {
  const admin = await adminSession();
  const created = await secured.app.request('/api/admin/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: admin.cookie,
      'x-csrf-token': admin.csrf,
    },
    body: JSON.stringify({ email, sites }),
  });
  expect(created.status).toBe(201);
  const minted = (await created.json()) as UserInviteMinted;
  const claimed = await secured.app.request(minted.url.replace('/welcome/', '/claim/'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'the-users-password' }),
  });
  expect(claimed.status).toBe(200);
  const { csrf } = (await claimed.json()) as { csrf: string };
  return { cookie: cookiesOf(claimed), csrf };
}

async function viewerSession(sites: number[]): Promise<Session> {
  await adminSession();
  const viewerId = withWriteTransaction(db, () => {
    db.prepare('INSERT INTO viewers (email, site_scope, created_at) VALUES (?, ?, ?)').run(
      'client@example.com',
      serializeSiteScope(sites),
      T0,
    );
    return Number(db.prepare('SELECT max(id) FROM viewers').pluck().get());
  });
  const issued = issueSession(db, ensureAuthSecret(db), T0, { kind: 'viewer', viewerId });
  return { cookie: `__Host-session=${issued.cookieValue}`, csrf: issued.csrfToken };
}

async function request(
  method: string,
  path: string,
  who?: Session,
  body?: unknown,
): Promise<Response> {
  return await secured.app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(who === undefined ? {} : { cookie: who.cookie, 'x-csrf-token': who.csrf }),
    },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}

describe('isManagerRoute — the classification itself', () => {
  it('opens exactly the management surface', () => {
    for (const [method, path] of [
      ['POST', '/api/admin/logout'],
      ['POST', '/api/admin/password'],
      ['POST', '/api/admin/sites'],
      ['PATCH', '/api/admin/sites/3'],
      ['DELETE', '/api/admin/sites/3'],
      ['GET', '/api/admin/dashboards'],
      ['PUT', '/api/admin/dashboards/1'],
      ['POST', '/api/admin/dashboards/1/share'],
      ['POST', '/api/admin/goals'],
      ['DELETE', '/api/admin/campaigns/2'],
      ['PUT', '/api/admin/annotations/1'],
      ['POST', '/api/admin/viewers'],
      ['DELETE', '/api/admin/tokens/1'],
    ] as const) {
      expect(isManagerRoute(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it('keeps the instance-wide surface admin-only — including near-miss names', () => {
    for (const [method, path] of [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users'],
      ['PUT', '/api/admin/data-settings'],
      ['DELETE', '/api/admin/props/1/key'],
      ['PUT', '/api/admin/exclusions'],
      ['GET', '/api/admin/diagnostics'],
      ['POST', '/api/admin/segments'],
      ['PUT', '/api/admin/derived-metrics/1'],
      ['PUT', '/api/admin/campaign-aliases'], // NOT /api/admin/campaigns
      ['PUT', '/api/admin/alerts'],
      ['PUT', '/api/admin/ntfy'],
      ['GET', '/api/admin/anything-added-tomorrow'],
    ] as const) {
      expect(isManagerRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe('the wall — manager routes open to users, the rest stay admin-only', () => {
  /** Wall verdicts only: user rows assert NOT-403 (handlers may 400/404), so
   * this stays true as handlers evolve; viewer/anonymous rows are exact. */
  it('walks every admin route family', async () => {
    const user = await userSession([1]);
    const viewer = await viewerSession([1]);

    const managerRoutes: Array<[string, string]> = [
      ['GET', '/api/admin/dashboards'],
      ['POST', '/api/admin/sites'],
      ['PATCH', '/api/admin/sites/1'],
      ['GET', '/api/admin/goals?site=1'],
      ['GET', '/api/admin/campaigns?site=1'],
      ['GET', '/api/admin/annotations'],
      ['GET', '/api/admin/viewers'],
      ['GET', '/api/admin/tokens'],
      ['POST', '/api/admin/password'],
    ];
    for (const [method, path] of managerRoutes) {
      expect((await request(method, path, user)).status, `user ${method} ${path}`).not.toBe(403);
      expect((await request(method, path, viewer)).status, `viewer ${method} ${path}`).toBe(403);
      expect((await request(method, path)).status, `anon ${method} ${path}`).toBe(401);
    }

    const adminOnlyRoutes: Array<[string, string]> = [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users'],
      ['GET', '/api/admin/data-settings'],
      ['GET', '/api/admin/exclusions'],
      ['GET', '/api/admin/diagnostics'],
      ['POST', '/api/admin/segments'],
      ['POST', '/api/admin/derived-metrics'],
      ['GET', '/api/admin/campaign-aliases?site=1'],
      ['GET', '/api/admin/alerts'],
      ['GET', '/api/admin/ntfy'],
      ['GET', '/api/admin/added-tomorrow'],
    ];
    for (const [method, path] of adminOnlyRoutes) {
      expect((await request(method, path, user)).status, `user ${method} ${path}`).toBe(403);
      expect((await request(method, path, viewer)).status, `viewer ${method} ${path}`).toBe(403);
      expect((await request(method, path)).status, `anon ${method} ${path}`).toBe(401);
    }
  });
});

describe('object scoping — out of scope answers exactly like nonexistent', () => {
  it('sites: a user edits and deletes their own, not site 2, and creates owned', async () => {
    const user = await userSession([1]);
    expect((await request('PATCH', '/api/admin/sites/1', user, { name: 'Mine' })).status).toBe(200);
    const foreign = await request('PATCH', '/api/admin/sites/2', user, { name: 'Theirs' });
    expect(foreign.status).toBe(404);
    const ghost = await request('PATCH', '/api/admin/sites/99', user, { name: 'Ghost' });
    expect(ghost.status).toBe(404);
    expect(await foreign.text()).toBe((await ghost.text()).replace('99', '2'));

    const created = await request('POST', '/api/admin/sites', user, {
      name: 'New',
      domains: ['new.test'],
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    // Ownership grew on create: the new site is immediately manageable…
    expect((await request('PATCH', `/api/admin/sites/${id}`, user, { name: 'N2' })).status).toBe(
      200,
    );
    // …and deletable, while site 2 is not.
    expect((await request('DELETE', `/api/admin/sites/${id}`, user)).status).toBe(200);
    expect((await request('DELETE', '/api/admin/sites/2', user)).status).toBe(404);
  });

  it('dashboards: writes bounded by scope; all-sites rows are admin-write', async () => {
    const admin = await adminSession();
    const mkDash = async (who: Session, site: number | 'all'): Promise<Response> =>
      request('POST', '/api/admin/dashboards', who, { name: `d-${site}`, site, grid: [] });
    const dashAll = (await (await mkDash(admin, 'all')).json()) as { id: number };
    const dash2 = (await (await mkDash(admin, 2)).json()) as { id: number };

    const user = await userSession([1]);
    expect((await mkDash(user, 1)).status).toBe(201);
    expect((await mkDash(user, 2)).status).toBe(404);
    expect((await mkDash(user, 'all')).status).toBe(403);

    // The admin's site-2 and all-sites rows answer like nonexistent ones.
    for (const id of [dash2.id, dashAll.id]) {
      expect(
        (
          await request('PUT', `/api/admin/dashboards/${id}`, user, {
            name: 'x',
            site: 1,
            grid: [],
          })
        ).status,
        `PUT dashboard ${id}`,
      ).toBe(404);
      expect((await request('DELETE', `/api/admin/dashboards/${id}`, user)).status).toBe(404);
      expect((await request('POST', `/api/admin/dashboards/${id}/duplicate`, user)).status).toBe(
        404,
      );
      expect((await request('POST', `/api/admin/dashboards/${id}/share`, user)).status).toBe(404);
    }
    // And the list simply omits them.
    const listed = await request('GET', '/api/admin/dashboards', user);
    const names = ((await listed.json()) as Array<{ name: string }>).map((d) => d.name);
    expect(names).toEqual(['d-1']);
  });

  it('goals and campaigns: site-bound CRUD, foreign rows invisible', async () => {
    const admin = await adminSession();
    const goal2 = await request('POST', '/api/admin/goals?site=2', admin, {
      name: 'theirs',
      filters: [{ dim: 'path', op: 'eq', value: '/buy' }],
    });
    expect(goal2.status).toBe(201);
    const { id: goalId } = (await goal2.json()) as { id: number };

    const user = await userSession([1]);
    expect((await request('GET', '/api/admin/goals?site=2', user)).status).toBe(404);
    expect(
      (await request('POST', '/api/admin/goals?site=2', user, { name: 'x', filters: [] })).status,
    ).toBe(404);
    expect((await request('DELETE', `/api/admin/goals/${goalId}`, user)).status).toBe(404);
    const mine = await request('POST', '/api/admin/goals?site=1', user, {
      name: 'mine',
      filters: [{ dim: 'path', op: 'eq', value: '/thanks' }],
    });
    expect(mine.status).toBe(201);

    expect((await request('GET', '/api/admin/campaigns?site=2', user)).status).toBe(404);
    expect((await request('GET', '/api/admin/campaigns?site=1', user)).status).toBe(200);
  });

  it('annotations: install-wide notes are admin-only; foreign rows invisible', async () => {
    const admin = await adminSession();
    const global = await request('POST', '/api/admin/annotations', admin, {
      siteId: null,
      ts: T0,
      text: 'deploy',
    });
    const { id: globalId } = (await global.json()) as { id: number };

    const user = await userSession([1]);
    expect(
      (await request('POST', '/api/admin/annotations', user, { siteId: null, ts: T0, text: 'x' }))
        .status,
    ).toBe(403);
    expect(
      (await request('POST', '/api/admin/annotations', user, { siteId: 2, ts: T0, text: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await request('POST', '/api/admin/annotations', user, { siteId: 1, ts: T0, text: 'mine' }))
        .status,
    ).toBe(201);
    expect((await request('DELETE', `/api/admin/annotations/${globalId}`, user)).status).toBe(404);
    // The user's management list holds only their own site's note.
    const listed = (await (await request('GET', '/api/admin/annotations', user)).json()) as Array<{
      text: string;
    }>;
    expect(listed.map((a) => a.text)).toEqual(['mine']);
  });

  it('minting is bounded by the minter, and mints are private to them', async () => {
    const admin = await adminSession();
    const adminToken = await request('POST', '/api/admin/tokens', admin, {
      name: 'admin token',
      sites: 'all',
    });
    expect(adminToken.status).toBe(201);
    const adminMint = (await adminToken.json()) as ApiTokenMinted;

    const user = await userSession([1]);
    // Grants must fit inside the user's own power.
    for (const sites of ['all', [2], [1, 2]] as const) {
      expect(
        (await request('POST', '/api/admin/tokens', user, { name: 't', sites })).status,
        `token scope ${JSON.stringify(sites)}`,
      ).toBe(400);
      expect(
        (await request('POST', '/api/admin/viewers', user, { email: 'v@example.com', sites }))
          .status,
        `viewer scope ${JSON.stringify(sites)}`,
      ).toBe(400);
    }
    const own = await request('POST', '/api/admin/tokens', user, { name: 'mine', sites: [1] });
    expect(own.status).toBe(201);
    const ownMint = (await own.json()) as ApiTokenMinted;

    // Listing shows only own mints; the admin's token is not the user's to revoke.
    const listed = (await (await request('GET', '/api/admin/tokens', user)).json()) as Array<{
      id: number;
    }>;
    expect(listed.map((t) => t.id)).toEqual([ownMint.id]);
    expect((await request('DELETE', `/api/admin/tokens/${adminMint.id}`, user)).status).toBe(404);
    expect((await request('DELETE', `/api/admin/tokens/${ownMint.id}`, user)).status).toBe(200);

    // Viewers: the same ownership rules, plus the email-conflict refusal.
    const adminViewer = await request('POST', '/api/admin/viewers', admin, {
      email: 'shared@example.com',
      sites: [2],
    });
    expect(adminViewer.status).toBe(201);
    const adminViewerId = ((await adminViewer.json()) as MagicLinkMinted).viewerId;
    const conflict = await request('POST', '/api/admin/viewers', user, {
      email: 'shared@example.com',
      sites: [1],
    });
    expect(conflict.status).toBe(409);
    const ownViewer = await request('POST', '/api/admin/viewers', user, {
      email: 'mine@example.com',
      sites: [1],
    });
    expect(ownViewer.status).toBe(201);
    const ownViewerId = ((await ownViewer.json()) as MagicLinkMinted).viewerId;
    const rows = (await (await request('GET', '/api/admin/viewers', user)).json()) as ViewerInfo[];
    expect(rows.map((v) => v.id)).toEqual([ownViewerId]);
    expect((await request('DELETE', `/api/admin/viewers/${adminViewerId}`, user)).status).toBe(404);
    expect((await request('POST', `/api/admin/viewers/${adminViewerId}/invite`, user)).status).toBe(
      404,
    );
    expect((await request('DELETE', `/api/admin/viewers/${ownViewerId}`, user)).status).toBe(200);
  });
});
