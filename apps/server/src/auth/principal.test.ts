import type { ApiTokenMinted } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import {
  addUserSite,
  type Db,
  disableUser,
  insertUser,
  withWriteTransaction,
} from '../db/index.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';
import { createRealtimeHub } from '../realtime/hub.ts';
import { createSecuredApp, type SecuredApp } from './app.ts';
import {
  canManageSite,
  canReadSite,
  isManager,
  parseSiteScope,
  readableSites,
  serializeSiteScope,
} from './principal.ts';
import { ensureAuthSecret, issueSession } from './session.ts';

/**
 * The principal axis of the route matrix (docs/04 § 5): what each kind of
 * principal — admin, viewer, token, none — can and cannot reach. app.test.ts
 * keeps the anonymous/admin rows; this file adds the scoped ones.
 */

const PASSWORD = 'a-decent-password';
const SETUP_TOKEN = 'test-setup-token';

const queryBody = (site: number | 'all'): string =>
  JSON.stringify({
    site,
    range: { preset: '7d' },
    queries: [{ id: 'k', metrics: ['pageviews'] }],
  });

let db: Db;
let secured: SecuredApp;
let pipeline: Pipeline;

beforeEach(() => {
  db = openTestDb(2); // sites 1 ('one.test') and 2 ('two.test')
  pipeline = createPipeline(db);
  secured = createSecuredApp({
    db,
    hub: createRealtimeHub(db),
    sink: pipeline.sink,
    pipeline,
    auth: { now: () => T0, env: {}, setupToken: SETUP_TOKEN },
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

/** First call claims the install; later calls in the same test log in. */
async function adminSession(): Promise<{ cookie: string; csrf: string }> {
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

async function mintToken(sites: 'all' | number[]): Promise<ApiTokenMinted> {
  const admin = await adminSession();
  const res = await secured.app.request('/api/admin/tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: admin.cookie,
      'x-csrf-token': admin.csrf,
    },
    body: JSON.stringify({ name: 'test token', sites }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ApiTokenMinted;
}

async function bearerRequest(
  token: string,
  path: string,
  init: { method?: string; body?: string; scheme?: string } = {},
): Promise<Response> {
  return await secured.app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `${init.scheme ?? 'Bearer'} ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

describe('scope helpers', () => {
  it('round-trips scopes and fails closed on garbage', () => {
    expect(parseSiteScope('all')).toBe('all');
    expect(parseSiteScope(serializeSiteScope([2, 5]))).toEqual(new Set([2, 5]));
    for (const garbage of ['', 'null', '{"a":1}', '[1,"2"]', '[0]', '[-3]', 'not json']) {
      expect(parseSiteScope(garbage)).toEqual(new Set());
    }
  });

  it('scopes reads; admin reads everything', () => {
    const admin = { kind: 'admin', sessionId: 's' } as const;
    const token = { kind: 'token', tokenId: 1, sites: new Set([2]) } as const;
    expect(canReadSite(admin, 999)).toBe(true);
    expect(canReadSite(token, 2)).toBe(true);
    expect(canReadSite(token, 1)).toBe(false);
    expect(readableSites(token, [1, 2, 3])).toEqual([2]);
    expect(readableSites({ ...token, sites: 'all' }, [1, 2])).toEqual([1, 2]);
  });
});

describe('token principals', () => {
  it('reads an in-scope site and is told an out-of-scope one does not exist', async () => {
    const minted = await mintToken([1]);
    const inScope = await bearerRequest(minted.token, '/api/query', {
      method: 'POST',
      body: queryBody(1),
    });
    expect(inScope.status).toBe(200);
    const outOfScope = await bearerRequest(minted.token, '/api/query', {
      method: 'POST',
      body: queryBody(2),
    });
    expect(outOfScope.status).toBe(404);
  });

  it("fans 'all' out over its own scope only", async () => {
    const minted = await mintToken([2]);
    const res = await bearerRequest(minted.token, '/api/query', {
      method: 'POST',
      body: queryBody('all'),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { windows: Array<{ siteId: number }> } };
    expect(body.meta.windows.map((w) => w.siteId)).toEqual([2]);
  });

  it('sees only its readable sites in the directory', async () => {
    const minted = await mintToken([2]);
    const res = await bearerRequest(minted.token, '/api/sites');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Array<{ id: number }>).map((s) => s.id)).toEqual([2]);
  });

  it('lists goals and campaigns for its own sites only; another site is nonexistent', async () => {
    const minted = await mintToken([1]);
    for (const list of ['/api/goals', '/api/campaigns']) {
      expect((await bearerRequest(minted.token, `${list}?site=1`)).status, list).toBe(200);
      const foreign = await bearerRequest(minted.token, `${list}?site=2`);
      const missing = await bearerRequest(minted.token, `${list}?site=99`);
      expect(foreign.status, list).toBe(404);
      expect(await foreign.json()).toEqual({ error: 'unknown site 2' });
      expect(missing.status, list).toBe(404);
      expect(await missing.json()).toEqual({ error: 'unknown site 99' });
    }
  });

  it('posts queries without a CSRF token — Bearer carries no ambient credential', async () => {
    const minted = await mintToken('all');
    const res = await bearerRequest(minted.token, '/api/query', {
      method: 'POST',
      body: queryBody(1),
    });
    expect(res.status).toBe(200);
  });

  it('reaches /mcp — the one surface that is token-ONLY', async () => {
    const minted = await mintToken('all');
    const res = await secured.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${minted.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    // A cookie session is 403'd there: no CSRF story, so no cookies at all.
    const admin = await adminSession();
    const cookie = await secured.app.request('/mcp', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(cookie.status).toBe(403);
  });

  it('is walled out of the whole admin surface', async () => {
    const minted = await mintToken('all');
    for (const [path, method] of [
      ['/api/admin/tokens', 'GET'],
      ['/api/admin/sites', 'POST'],
      ['/api/admin/diagnostics', 'GET'],
      ['/api/admin/dashboards', 'GET'],
      ['/api/admin/viewers', 'GET'],
    ] as const) {
      const res = await bearerRequest(minted.token, path, {
        method,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('dies on revocation, and a wrong token never falls back to a cookie', async () => {
    const minted = await mintToken('all');
    const admin = await adminSession();
    const revoke = await secured.app.request(`/api/admin/tokens/${minted.id}`, {
      method: 'DELETE',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(revoke.status).toBe(200);
    const afterRevoke = await bearerRequest(minted.token, '/api/query', {
      method: 'POST',
      body: queryBody(1),
    });
    expect(afterRevoke.status).toBe(401);

    // Live cookie + bad Bearer: answered as the Bearer it presented.
    const withCookie = await secured.app.request('/api/query', {
      method: 'POST',
      headers: {
        authorization: `Bearer fs_${'x'.repeat(43)}`,
        cookie: admin.cookie,
        'content-type': 'application/json',
      },
      body: queryBody(1),
    });
    expect(withCookie.status).toBe(401);
  });

  it('rejects malformed bearer values by shape, before any lookup', async () => {
    for (const bad of ['fs_short', 'nope', `fs_${'x'.repeat(44)}`, ' ']) {
      const res = await bearerRequest(bad, '/api/sites');
      expect(res.status).toBe(401);
    }
  });

  /**
   * RFC 7235: `auth-scheme` is a case-insensitive token, so `bearer` and
   * `BEARER` name the same scheme — a client spelling it lowercase is not
   * unauthorized. The credential after it stays case-SENSITIVE: an fs_ token is
   * base64url, and folding it would turn a mistyped token into a different one.
   */
  it.each(['Bearer', 'bearer', 'BEARER', 'BeArEr'])(
    'reads the scheme case-insensitively, spelled %s, and the token exactly',
    async (scheme) => {
      const minted = await mintToken('all');
      expect((await bearerRequest(minted.token, '/api/sites', { scheme })).status).toBe(200);
      const folded = `FS_${minted.token.slice(3)}`;
      expect((await bearerRequest(folded, '/api/sites', { scheme })).status).toBe(401);
      expect((await bearerRequest(`fs_${'x'.repeat(43)}`, '/api/sites', { scheme })).status).toBe(
        401,
      );
    },
  );

  it('is not fooled by a scheme that merely starts with the word', async () => {
    const minted = await mintToken('all');
    for (const scheme of ['Bearerish', 'Basic', 'Bear']) {
      expect((await bearerRequest(minted.token, '/api/sites', { scheme })).status).toBe(401);
    }
  });
});

describe('scope helpers — managers', () => {
  const admin = { kind: 'admin', sessionId: 's' } as const;
  const user = { kind: 'user', sessionId: 's', userId: 7, sites: new Set([2]) } as const;
  const viewer = { kind: 'viewer', sessionId: 's', viewerId: 1, sites: 'all' } as const;
  const token = { kind: 'token', tokenId: 1, sites: 'all' } as const;

  it('managers are the admin and users, nobody else', () => {
    expect(isManager(admin)).toBe(true);
    expect(isManager(user)).toBe(true);
    expect(isManager(viewer)).toBe(false);
    expect(isManager(token)).toBe(false);
  });

  it('writing is narrower than reading: only the admin and the owning user', () => {
    expect(canManageSite(admin, 999)).toBe(true);
    expect(canManageSite(user, 2)).toBe(true);
    expect(canManageSite(user, 1)).toBe(false);
    // An all-scope viewer or token READS everything and manages nothing.
    expect(canReadSite(viewer, 1)).toBe(true);
    expect(canManageSite(viewer, 1)).toBe(false);
    expect(canManageSite(token, 1)).toBe(false);
  });
});

describe('user principals', () => {
  async function userCookie(sites: number[]): Promise<{ cookie: string; userId: number }> {
    await adminSession(); // sets the password so auth is configured
    const userId = withWriteTransaction(db, () => {
      const user = insertUser(db, 'owner@example.com', T0);
      for (const siteId of sites) addUserSite(db, user.id, siteId);
      return user.id;
    });
    const issued = issueSession(db, ensureAuthSecret(db), T0, { kind: 'user', userId });
    return { cookie: `__Host-session=${issued.cookieValue}`, userId };
  }

  it('reads its own sites and is told the rest do not exist', async () => {
    const { cookie } = await userCookie([2]);
    const sites = await secured.app.request('/api/sites', { headers: { cookie } });
    expect(((await sites.json()) as Array<{ id: number }>).map((s) => s.id)).toEqual([2]);

    const query = await secured.app.request('/api/query', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: queryBody(2),
    });
    expect(query.status).toBe(200);

    const outOfScope = await secured.app.request('/api/query', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: queryBody(1),
    });
    expect(outOfScope.status).toBe(404);
  });

  it('dies when the user is disabled, even with a live session', async () => {
    const { cookie, userId } = await userCookie([2]);
    withWriteTransaction(db, () => {
      disableUser(db, userId, T0 + 1);
    });
    const res = await secured.app.request('/api/sites', { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it('is 403d from /mcp like any cookie session', async () => {
    const { cookie } = await userCookie([2]);
    const res = await secured.app.request('/mcp', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});

describe('viewer principals', () => {
  async function viewerCookie(sites: number[]): Promise<string> {
    await adminSession(); // sets the password so auth is configured
    const viewerId = withWriteTransaction(db, () => {
      db.prepare('INSERT INTO viewers (email, site_scope, created_at) VALUES (?, ?, ?)').run(
        'client@example.com',
        serializeSiteScope(sites),
        T0,
      );
      return Number(db.prepare('SELECT id FROM viewers').pluck().get());
    });
    const secret = ensureAuthSecret(db);
    const issued = issueSession(db, secret, T0, { kind: 'viewer', viewerId });
    return `__Host-session=${issued.cookieValue}`;
  }

  it('reads scoped data but never the admin surface', async () => {
    const cookie = await viewerCookie([2]);
    const sites = await secured.app.request('/api/sites', { headers: { cookie } });
    expect(((await sites.json()) as Array<{ id: number }>).map((s) => s.id)).toEqual([2]);

    const query = await secured.app.request('/api/query', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: queryBody(2),
    });
    expect(query.status).toBe(200);

    const admin = await secured.app.request('/api/admin/diagnostics', { headers: { cookie } });
    expect(admin.status).toBe(403);

    const outOfScope = await secured.app.request('/api/query', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: queryBody(1),
    });
    expect(outOfScope.status).toBe(404);

    for (const list of ['/api/goals', '/api/campaigns']) {
      const own = await secured.app.request(`${list}?site=2`, { headers: { cookie } });
      const foreign = await secured.app.request(`${list}?site=1`, { headers: { cookie } });
      expect(own.status, list).toBe(200);
      expect(foreign.status, list).toBe(404);
    }
  });

  it('is 403d from /mcp like any cookie session', async () => {
    const cookie = await viewerCookie([2]);
    const res = await secured.app.request('/mcp', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('dies when the viewer is revoked, even with a live session', async () => {
    const cookie = await viewerCookie([2]);
    withWriteTransaction(db, () => {
      db.prepare('UPDATE viewers SET revoked_at = ?').run(T0 + 1);
    });
    const res = await secured.app.request('/api/sites', { headers: { cookie } });
    expect(res.status).toBe(401);
  });
});

describe('dashboards reads (GET /api/dashboards — docs/04 § 5)', () => {
  /** Stores one dashboard per scope; returns ids keyed by scope. */
  async function seedDashboards(): Promise<Record<'one' | 'two' | 'all', number>> {
    const admin = await adminSession();
    const ids: number[] = [];
    for (const site of [1, 2, 'all'] as const) {
      const res = await secured.app.request('/api/admin/dashboards', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: admin.cookie,
          'x-csrf-token': admin.csrf,
        },
        body: JSON.stringify({ name: `dash-${site}`, site, grid: [] }),
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { id: number }).id);
    }
    return { one: ids[0] as number, two: ids[1] as number, all: ids[2] as number };
  }

  async function namesSeenBy(headers: Record<string, string>): Promise<string[]> {
    const res = await secured.app.request('/api/dashboards', { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as Array<{ name: string }>).map((row) => row.name).sort();
  }

  /** Mint with an existing admin session — the login limiter's clock is frozen. */
  async function mintWith(
    admin: { cookie: string; csrf: string },
    sites: 'all' | number[],
  ): Promise<ApiTokenMinted> {
    const res = await secured.app.request('/api/admin/tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: admin.cookie,
        'x-csrf-token': admin.csrf,
      },
      body: JSON.stringify({ name: 'test token', sites }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as ApiTokenMinted;
  }

  it('scopes the list per principal; all-sites dashboards need an all scope', async () => {
    const ids = await seedDashboards();
    const admin = await adminSession();
    expect(await namesSeenBy({ cookie: admin.cookie })).toEqual(['dash-1', 'dash-2', 'dash-all']);

    const token = await mintWith(admin, [2]);
    const bearer = { authorization: `Bearer ${token.token}` };
    expect(await namesSeenBy(bearer)).toEqual(['dash-2']);

    const wideToken = await mintWith(admin, 'all');
    expect(await namesSeenBy({ authorization: `Bearer ${wideToken.token}` })).toEqual([
      'dash-1',
      'dash-2',
      'dash-all',
    ]);

    // Out of scope answers exactly like nonexistent, on the detail route too.
    expect((await bearerRequest(token.token, `/api/dashboards/${ids.two}`)).status).toBe(200);
    expect((await bearerRequest(token.token, `/api/dashboards/${ids.one}`)).status).toBe(404);
    expect((await bearerRequest(token.token, `/api/dashboards/${ids.all}`)).status).toBe(404);
  });

  it('shows a viewer its scoped rows and keeps the admin paths admin-only', async () => {
    const ids = await seedDashboards();
    const viewerId = withWriteTransaction(db, () => {
      db.prepare('INSERT INTO viewers (email, site_scope, created_at) VALUES (?, ?, ?)').run(
        'client@example.com',
        serializeSiteScope([2]),
        T0,
      );
      return Number(db.prepare('SELECT max(id) FROM viewers').pluck().get());
    });
    const issued = issueSession(db, ensureAuthSecret(db), T0, { kind: 'viewer', viewerId });
    const cookie = `__Host-session=${issued.cookieValue}`;

    expect(await namesSeenBy({ cookie })).toEqual(['dash-2']);
    const detail = await secured.app.request(`/api/dashboards/${ids.two}`, {
      headers: { cookie },
    });
    expect(detail.status).toBe(200);
    expect(
      (await secured.app.request(`/api/dashboards/${ids.all}`, { headers: { cookie } })).status,
    ).toBe(404);
    // The legacy admin read path stays walled.
    expect(
      (await secured.app.request('/api/admin/dashboards', { headers: { cookie } })).status,
    ).toBe(403);
  });
});
