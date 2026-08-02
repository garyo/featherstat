import type { ApiTokenMinted } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { type Db, withWriteTransaction } from '../db/index.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';
import { createRealtimeHub } from '../realtime/hub.ts';
import { createSecuredApp, type SecuredApp } from './app.ts';
import { canReadSite, parseSiteScope, readableSites, serializeSiteScope } from './principal.ts';
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
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  return await secured.app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
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

  it('posts queries without a CSRF token — Bearer carries no ambient credential', async () => {
    const minted = await mintToken('all');
    const res = await bearerRequest(minted.token, '/api/query', {
      method: 'POST',
      body: queryBody(1),
    });
    expect(res.status).toBe(200);
  });

  it('is walled out of the whole admin surface', async () => {
    const minted = await mintToken('all');
    for (const [path, method] of [
      ['/api/admin/tokens', 'GET'],
      ['/api/admin/sites', 'POST'],
      ['/api/admin/diagnostics', 'GET'],
      ['/api/admin/dashboards', 'GET'],
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
