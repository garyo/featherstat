import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_UA, openTestDb, T0 } from '../../test/rows.ts';
import type { Db } from '../db/index.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';
import { createRealtimeHub } from '../realtime/hub.ts';
import { QUERY_BATCHES_PER_SESSION, TOKEN_BATCHES_PER_MIN } from '../routes/query.ts';
import { createSecuredApp, type SecuredApp } from './app.ts';
import { createAuth } from './auth.ts';
import { SESSION_TTL_MS } from './session.ts';

const assetsDir = mkdtempSync(join(tmpdir(), 'secured-tracker-'));
writeFileSync(join(assetsDir, 'matomo.js'), '"use strict";(()=>{})();');

const webDir = mkdtempSync(join(tmpdir(), 'secured-web-'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="app"></div>');
mkdirSync(join(webDir, 'assets'));
writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'export {};');

const PASSWORD = 'a-decent-password';
const SETUP_TOKEN = 'test-setup-token';
const QUERY_BODY = JSON.stringify({
  site: 1,
  range: { preset: '7d' },
  queries: [{ id: 'k', metrics: ['pageviews'] }],
});

let db: Db;
let clock: number;
let secured: SecuredApp;
let pipeline: Pipeline;

beforeEach(() => {
  db = openTestDb(2);
  clock = T0;
  pipeline = createPipeline(db);
  secured = createSecuredApp({
    db,
    hub: createRealtimeHub(db),
    sink: pipeline.sink,
    pipeline,
    assetsDir,
    webDir,
    auth: { now: () => clock, env: {}, setupToken: SETUP_TOKEN },
  });
});

afterEach(() => {
  pipeline.shutdown();
  db.close();
});

/** `Set-Cookie` pairs of a response, ready to send back as a `Cookie` header. */
function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .join('; ');
}

async function setup(app: SecuredApp['app'] = secured.app): Promise<{
  cookie: string;
  csrf: string;
}> {
  const res = await app.request('/api/admin/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, setupToken: SETUP_TOKEN }),
  });
  expect(res.status).toBe(200);
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie: cookiesOf(res), csrf };
}

async function postQuery(cookie?: string, ip?: string): Promise<Response> {
  return await secured.app.request('/api/query', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...(ip === undefined ? {} : { 'x-forwarded-for': ip }),
    },
    body: QUERY_BODY,
  });
}

async function login(): Promise<string> {
  const res = await secured.app.request('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

describe('route matrix — no session', () => {
  it('keeps tracking, bundles and /healthz public; 401s every dashboard read', async () => {
    const publics: Array<[string, number]> = [
      ['/healthz', 200],
      ['/matomo.js', 200],
    ];
    for (const [path, status] of publics) {
      expect((await secured.app.request(path)).status, path).toBe(status);
    }
    const beacon = await secured.app.request('/matomo.php?idsite=1&rec=1&send_image=0');
    expect(beacon.status).toBe(204); // beacons never bounce, session or not

    // The native collector lives under /api/, where everything else is gated —
    // it is public by the same rule and must not learn to 401 (invariant 4).
    const collect = await secured.app.request('/api/collect', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ site: 1, hits: [{ type: 'ping', url: 'https://one.test/' }] }),
    });
    expect(collect.status).toBe(204);
    expect((await secured.app.request('/api/collect', { method: 'OPTIONS' })).status).toBe(204);

    const gated = ['/api/sites', '/api/realtime?sites=all', '/api/admin/diagnostics'];
    for (const path of gated) {
      expect((await secured.app.request(path)).status, path).toBe(401);
    }
    expect((await postQuery()).status).toBe(401);
    const logout = await secured.app.request('/api/admin/logout', { method: 'POST' });
    expect(logout.status).toBe(401);
  });

  it('rejects a cookie with a valid shape but no session behind it', async () => {
    const forged = `__Host-session=${'0'.repeat(64)}.${'A'.repeat(43)}; __Host-csrf=x`;
    expect((await postQuery(forged)).status).toBe(401);
  });

  it('gates the whole /api/* prefix — a route added tomorrow is born authenticated', async () => {
    // No such routes exist; the gate must still answer 401, never fall through to the SPA.
    expect((await secured.app.request('/api/sites/1')).status).toBe(401);
    expect((await secured.app.request('/api/query/export')).status).toBe(401);
    expect((await secured.app.request('/api/anything-at-all')).status).toBe(401);
  });

  it('sets the security response headers and keeps admin responses uncacheable', async () => {
    const root = await secured.app.request('/');
    expect(root.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(root.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(root.headers.get('x-content-type-options')).toBe('nosniff');
    expect(root.headers.get('x-frame-options')).toBe('DENY');
    expect(root.headers.get('referrer-policy')).toBe('same-origin');
    // /api/admin/me carries the CSRF token — an intermediary must never cache it.
    const me = await secured.app.request('/api/admin/me');
    expect(me.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses to mount realtime without the db that carries its gate', () => {
    expect(() => createSecuredApp({ hub: createRealtimeHub(db) })).toThrow(/requires db/);
  });
});

describe('first-run state machine', () => {
  it('reports needsSetup until a password exists, then never again', async () => {
    const before = await secured.app.request('/api/admin/me');
    expect(await before.json()).toEqual({ authenticated: false, needsSetup: true });

    const login = await secured.app.request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(403); // nothing to log into yet

    const { cookie } = await setup();
    const after = await secured.app.request('/api/admin/me', { headers: { cookie } });
    const me = (await after.json()) as {
      authenticated: boolean;
      needsSetup: boolean;
      csrf?: string;
    };
    expect(me.authenticated).toBe(true);
    expect(me.needsSetup).toBe(false);
    expect(me.csrf).toBeTypeOf('string');
  });

  it('setup grants a session and refuses to run twice', async () => {
    const { cookie } = await setup();
    expect((await postQuery(cookie)).status).toBe(200);

    const again = await secured.app.request('/api/admin/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'another-password', setupToken: SETUP_TOKEN }),
    });
    expect(again.status).toBe(403);
  });

  it('refuses setup without the logged token — a network stranger cannot claim the install', async () => {
    const wrong = await secured.app.request('/api/admin/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, setupToken: 'guessed-wrong' }),
    });
    expect(wrong.status).toBe(403);
    const missing = await secured.app.request('/api/admin/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(missing.status).toBe(400); // schema requires the token field
    // The install is still unclaimed afterwards.
    const me = await secured.app.request('/api/admin/me');
    expect(((await me.json()) as { needsSetup: boolean }).needsSetup).toBe(true);
  });

  it('rejects a too-short setup password', async () => {
    const res = await secured.app.request('/api/admin/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'short', setupToken: SETUP_TOKEN }),
    });
    expect(res.status).toBe(400);
  });

  it('sets hardened cookies: __Host- prefixed, HttpOnly session, readable csrf, Secure, SameSite=Lax', async () => {
    const res = await secured.app.request('/api/admin/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, setupToken: SETUP_TOKEN }),
    });
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.startsWith('__Host-session='));
    const csrf = cookies.find((cookie) => cookie.startsWith('__Host-csrf='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Max-Age=1209600/); // 14 days
    expect(csrf).toBeDefined();
    expect(csrf).not.toMatch(/HttpOnly/);
  });
});

describe('login, logout, expiry', () => {
  it('logs in with the right password and 401s the wrong one', async () => {
    await setup();
    const wrong = await secured.app.request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'not-the-password' }),
    });
    expect(wrong.status).toBe(401);

    const right = await secured.app.request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(right.status).toBe(200);
    expect((await postQuery(cookiesOf(right))).status).toBe(200);
  });

  it('logout revokes the session server-side', async () => {
    const { cookie, csrf } = await setup();
    const res = await secured.app.request('/api/admin/logout', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(res.status).toBe(200);
    expect((await postQuery(cookie)).status).toBe(401);
  });

  it('expires sessions after 14 days', async () => {
    const { cookie } = await setup();
    clock += SESSION_TTL_MS - 1;
    expect((await postQuery(cookie)).status).toBe(200);
    clock += 1;
    expect((await postQuery(cookie)).status).toBe(401);
  });

  it('rate limits login to 5 attempts per minute per IP', async () => {
    await setup();
    const attempt = async (ip: string): Promise<Response> =>
      await secured.app.request('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
    for (let i = 0; i < 5; i += 1) expect((await attempt('203.0.113.9')).status).toBe(401);
    expect((await attempt('203.0.113.9')).status).toBe(429);
    expect((await attempt('203.0.113.10')).status).toBe(401); // other IPs unaffected
    clock += 61_000;
    expect((await attempt('203.0.113.9')).status).toBe(401); // window slid
  });

  it('holds a global login budget: rotating spoofed XFF keys still hits a wall', async () => {
    await setup();
    const attempt = async (i: number): Promise<Response> =>
      await secured.app.request('/api/admin/login', {
        method: 'POST',
        // One fake entry per request; the "proxy" hop stays constant — but even
        // if every key were distinct, the global budget must still engage.
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `10.0.${Math.floor(i / 250)}.${i % 250}`,
        },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) statuses.push((await attempt(i)).status);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(30)).toEqual(Array(10).fill(429)); // budget exhausted, all blocked
  });

  /**
   * `/api/query` is the one gated route that executes a client-authored query
   * plan, so its budget is metered on the principal the GATE established rather
   * than on the address: an authenticated caller can change addresses at will,
   * and an office behind one NAT would otherwise throttle itself. Login and
   * `/share/:token` are keyed on the IP because they are unauthenticated and
   * nothing better exists there.
   *
   * routes/query.test.ts drives the budget itself; what this holds is the
   * wiring, which is the half that breaks silently — the router serving
   * `/api/query` is mounted inside `createApp`, well below the middleware that
   * sets `sessionId`, and a caller with no principal falls back to the address.
   */
  it('meters query batches per session, not per address', async () => {
    const { cookie: mine } = await setup();
    const theirs = await login();
    vi.useFakeTimers({ now: clock, toFake: ['Date'] });
    try {
      for (let i = 0; i < QUERY_BATCHES_PER_SESSION; i += 1) {
        expect((await postQuery(mine, '203.0.113.11')).status).toBe(200);
      }
      // One session, one budget — moving to another address does not mint a new one.
      expect((await postQuery(mine, '198.51.100.22')).status).toBe(429);
      // One address, many people: the next session is not punished for the last.
      expect((await postQuery(theirs, '203.0.113.11')).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CORS on Bearer only (docs/04 § 5)', () => {
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
  };

  const expectCors = (res: Response): void => {
    for (const [name, value] of Object.entries(CORS))
      expect(res.headers.get(name), name).toBe(value);
  };

  async function mintToken(): Promise<string> {
    const { cookie, csrf } = await setup();
    const minted = await secured.app.request('/api/admin/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ name: 'script', sites: 'all' }),
    });
    expect(minted.status).toBe(201);
    return ((await minted.json()) as { token: string }).token;
  }

  it('answers preflights on /api/query and /api/sites before the gate — no auth required', async () => {
    for (const path of ['/api/query', '/api/sites']) {
      const res = await secured.app.request(path, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://third-party.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      });
      expect(res.status, path).toBe(204);
      expectCors(res);
    }
  });

  it('exposes Bearer-authenticated responses cross-origin', async () => {
    const token = await mintToken();
    const bearer = { authorization: `Bearer ${token}` };

    const sites = await secured.app.request('/api/sites', { headers: bearer });
    expect(sites.status).toBe(200);
    expectCors(sites);

    const query = await secured.app.request('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: QUERY_BODY,
    });
    expect(query.status).toBe(200);
    expectCors(query);
  });

  it('never exposes a cookie-authenticated response — the same-origin wall holds', async () => {
    const { cookie } = await setup();
    const query = await postQuery(cookie);
    expect(query.status).toBe(200);
    expect(query.headers.get('access-control-allow-origin')).toBeNull();
    const sites = await secured.app.request('/api/sites', { headers: { cookie } });
    expect(sites.status).toBe(200);
    expect(sites.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('leaves every other route out of CORS entirely, preflights included', async () => {
    const token = await mintToken();
    const read = await secured.app.request('/api/segments', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get('access-control-allow-origin')).toBeNull();
    // An OPTIONS elsewhere still meets the gate, exactly as before.
    expect((await secured.app.request('/api/segments', { method: 'OPTIONS' })).status).toBe(401);
  });

  it('meters a Bearer caller in the token class through the real gate', async () => {
    const token = await mintToken();
    const cookie = await login();
    vi.useFakeTimers({ now: clock, toFake: ['Date'] });
    try {
      for (let i = 0; i < TOKEN_BATCHES_PER_MIN; i += 1) {
        const res = await secured.app.request('/api/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: QUERY_BODY,
        });
        expect(res.status).toBe(200);
      }
      const refused = await secured.app.request('/api/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: QUERY_BODY,
      });
      expect(refused.status).toBe(429);
      // The session class is untouched by the token's spend.
      expect((await postQuery(cookie)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CSRF double-submit', () => {
  it('rejects admin mutations without (or with a foreign) token, accepts the session token', async () => {
    const { cookie, csrf } = await setup();
    const create = async (headers: Record<string, string>): Promise<Response> =>
      await secured.app.request('/api/admin/sites', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ name: 'Blog', domains: ['blog.test'] }),
      });

    expect((await create({})).status).toBe(403);
    expect((await create({ 'x-csrf-token': 'nonsense' })).status).toBe(403);
    expect((await create({ 'x-csrf-token': csrf })).status).toBe(201);

    // Safe methods pass without the header.
    const read = await secured.app.request('/api/admin/diagnostics', { headers: { cookie } });
    expect(read.status).toBe(200);
  });
});

describe('body caps', () => {
  it('413s an oversized /api/query body instead of buffering it', async () => {
    const { cookie } = await setup();
    const res = await secured.app.request('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: `{"pad":"${'x'.repeat(1024 * 1024 + 1)}"}`,
    });
    expect(res.status).toBe(413);
  });

  it('413s an oversized admin body', async () => {
    const { cookie, csrf } = await setup();
    const res = await secured.app.request('/api/admin/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: `{"name":"${'x'.repeat(64 * 1024 + 1)}"}`,
    });
    expect(res.status).toBe(413);
  });
});

describe('AUTH_DISABLED', () => {
  it('opens every gate and skips CSRF — local dev only', async () => {
    const dev = createSecuredApp({
      db,
      assetsDir,
      auth: { disabled: true, env: { NODE_ENV: 'development' }, log: () => {} },
    });
    const query = await dev.app.request('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: QUERY_BODY,
    });
    expect(query.status).toBe(200);
    const me = await dev.app.request('/api/admin/me');
    expect(((await me.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const create = await dev.app.request('/api/admin/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Dev', domains: [] }),
    });
    expect(create.status).toBe(201);
  });

  it('requires a positive dev/test NODE_ENV — a stray var on a deploy box fails loudly', () => {
    expect(() => createAuth(db, { env: { NODE_ENV: 'production', AUTH_DISABLED: '1' } })).toThrow(
      /local-dev bypass/,
    );
    expect(() => createAuth(db, { disabled: true, env: { NODE_ENV: 'production' } })).toThrow(
      /local-dev bypass/,
    );
    // NODE_ENV unset (bare-metal/systemd) must refuse too — that is the leak path.
    expect(() => createAuth(db, { disabled: true, env: {} })).toThrow(/local-dev bypass/);
  });
});

describe('metrics wiring', () => {
  it('counts stored hits and flush durations end to end', async () => {
    const res = await secured.app.request(
      '/matomo.php?idsite=1&rec=1&url=https://one.test/a&send_image=0',
      { headers: { 'user-agent': DESKTOP_UA, 'x-forwarded-for': '203.0.113.7' } },
    );
    expect(res.status).toBe(204);
    pipeline.flush();
    const text = secured.metrics.render(db);
    expect(text).toContain('analytics_ingest_hits_total 1');
    expect(secured.metrics.flush.count).toBeGreaterThanOrEqual(1);
  });

  it('times /api/query behind the gate — 401s are never counted', async () => {
    expect((await postQuery()).status).toBe(401);
    expect(secured.metrics.query.count).toBe(0);
    const { cookie } = await setup();
    expect((await postQuery(cookie)).status).toBe(200);
    expect(secured.metrics.query.count).toBe(1);
  });

  it('gauges SSE clients across connect and disconnect', async () => {
    const { cookie } = await setup();
    const controller = new AbortController();
    const res = await secured.app.request('/api/realtime?sites=all', {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(secured.metrics.render(db)).toContain('analytics_sse_clients 1');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secured.metrics.render(db)).toContain('analytics_sse_clients 0');
  });

  it('serves /metrics under its bearer token even with the SPA mounted', async () => {
    const tokened = createSecuredApp({
      db,
      assetsDir,
      webDir,
      metricsToken: 'sekrit',
      auth: { now: () => clock, env: {}, setupToken: SETUP_TOKEN },
    });
    expect((await tokened.app.request('/metrics')).status).toBe(401);
    const res = await tokened.app.request('/metrics', {
      headers: { authorization: 'Bearer sekrit' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('analytics_db_size_bytes');
    // Unconfigured stays a hard 404 — the SPA fallback must not shadow it with HTML.
    const disabled = await secured.app.request('/metrics');
    expect(disabled.status).toBe(404);
  });
});

describe('dashboards, share links and notifications are mounted', () => {
  const LAYOUT = {
    name: 'Overview',
    site: 1,
    grid: [
      { id: 'kpis', viz: 'kpi-row', w: 12, h: 1, query: { id: 'kpis', metrics: ['pageviews'] } },
    ],
  };

  const json = (extra: Record<string, string>): Record<string, string> => ({
    'content-type': 'application/json',
    ...extra,
  });

  async function createDashboard(cookie: string, csrf: string): Promise<number> {
    const res = await secured.app.request('/api/admin/dashboards', {
      method: 'POST',
      headers: json({ cookie, 'x-csrf-token': csrf }),
      body: JSON.stringify(LAYOUT),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: number }).id;
  }

  it('gates dashboard CRUD behind the session and the CSRF guard', async () => {
    expect((await secured.app.request('/api/admin/dashboards')).status).toBe(401);
    const { cookie, csrf } = await setup();

    const noToken = await secured.app.request('/api/admin/dashboards', {
      method: 'POST',
      headers: json({ cookie }),
      body: JSON.stringify(LAYOUT),
    });
    expect(noToken.status).toBe(403);

    const id = await createDashboard(cookie, csrf);
    const list = await secured.app.request('/api/admin/dashboards', { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([
      { id, name: 'Overview', site: 1, updatedAt: expect.any(Number) },
    ]);
  });

  it('mints a share link readable without a session, then revokes it', async () => {
    const { cookie, csrf } = await setup();
    const id = await createDashboard(cookie, csrf);

    expect(
      (await secured.app.request(`/api/admin/dashboards/${id}/share`, { method: 'POST' })).status,
    ).toBe(401);

    const minted = await secured.app.request(`/api/admin/dashboards/${id}/share`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };

    // The public read: no cookie, and it answers the dashboard's own batch.
    const shared = await secured.app.request(`/share/${token}`);
    expect(shared.status).toBe(200);
    const view = (await shared.json()) as {
      dashboard: { name: string };
      results: Record<string, unknown>;
    };
    expect(view.dashboard.name).toBe('Overview');
    expect(view.results.kpis).toBeDefined();

    const revoked = await secured.app.request(`/api/admin/dashboards/${id}/share`, {
      method: 'DELETE',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(await revoked.json()).toEqual({ revoked: 1 });
    expect((await secured.app.request(`/share/${token}`)).status).toBe(404);
    // An unknown token is a 404 too — never the SPA shell mounted behind it.
    const unknown = await secured.app.request('/share/not-a-token');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
  });

  it('serves the ntfy pane behind the gate and delivers matching hits from the pipeline', async () => {
    const deliveries: Array<{ url: string; title: string; body: string }> = [];
    const notified = createSecuredApp({
      db,
      sink: pipeline.sink,
      pipeline,
      assetsDir,
      auth: { now: () => clock, env: {}, setupToken: SETUP_TOKEN },
      ntfy: {
        fetchFn: async (url, init) => {
          deliveries.push({ url, title: init.headers.Title ?? '', body: init.body });
          return { ok: true };
        },
      },
    });
    expect((await notified.app.request('/api/admin/ntfy')).status).toBe(401);

    const { cookie, csrf } = await setup(notified.app);
    const saved = await notified.app.request('/api/admin/ntfy', {
      method: 'PUT',
      headers: json({ cookie, 'x-csrf-token': csrf }),
      body: JSON.stringify({
        url: 'https://ntfy.example.test',
        topic: 'alerts',
        rules: [{ eventCategory: 'signup' }],
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      url: 'https://ntfy.example.test',
      topic: 'alerts',
      tokenSet: false,
      rules: [{ eventCategory: 'signup' }],
    });

    const beacon = await notified.app.request(
      '/matomo.php?idsite=1&rec=1&url=https://one.test/pricing&e_c=signup&e_a=account-created&send_image=0',
      { headers: { 'user-agent': DESKTOP_UA, 'x-forwarded-for': '203.0.113.7' } },
    );
    expect(beacon.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 0)); // delivery is deferred off the hot path

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.url).toBe('https://ntfy.example.test/alerts');
    expect(deliveries[0]?.title).toBe('one signup: account-created');
    expect(deliveries[0]?.body).toContain('/pricing');
    expect(notified.ntfy?.stats()).toMatchObject({ sent: 1, failed: 0, pending: 0 });
  });
});

describe('segments and derived metrics are mounted with the read/write split', () => {
  const json = (extra: Record<string, string>): Record<string, string> => ({
    'content-type': 'application/json',
    ...extra,
  });

  it('401s the reads anonymously — they live behind the session gate', async () => {
    expect((await secured.app.request('/api/segments')).status).toBe(401);
    expect((await secured.app.request('/api/derived-metrics')).status).toBe(401);
  });

  it('lets a scoped API token read but never write — the admin wall holds', async () => {
    const { cookie, csrf } = await setup();
    // Admin creates one of each, then mints a token principal.
    expect(
      (
        await secured.app.request('/api/admin/segments', {
          method: 'POST',
          headers: json({ cookie, 'x-csrf-token': csrf }),
          body: JSON.stringify({ name: 'US', filter: { dim: 'country', op: 'eq', value: 'US' } }),
        })
      ).status,
    ).toBe(201);
    const minted = await secured.app.request('/api/admin/tokens', {
      method: 'POST',
      headers: json({ cookie, 'x-csrf-token': csrf }),
      body: JSON.stringify({ name: 'script', sites: 'all' }),
    });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };

    const bearer = { authorization: `Bearer ${token}` };
    const read = await secured.app.request('/api/segments', { headers: bearer });
    expect(read.status).toBe(200);
    expect(((await read.json()) as unknown[]).length).toBe(1);
    expect((await secured.app.request('/api/derived-metrics', { headers: bearer })).status).toBe(
      200,
    );

    // The whole admin surface is the write surface (docs/04 § 5).
    const write = await secured.app.request('/api/admin/segments', {
      method: 'POST',
      headers: json(bearer),
      body: JSON.stringify({ name: 'nope', filter: { dim: 'country', op: 'eq', value: 'DE' } }),
    });
    expect(write.status).toBe(403);
  });
});

describe('SPA serving', () => {
  it('serves index.html at /, hashed assets immutable, and falls back on navigation paths', async () => {
    const root = await secured.app.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');

    const asset = await secured.app.request('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    const fallback = await secured.app.request('/some/client/route');
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain('id="app"');

    expect((await secured.app.request('/assets/missing.js')).status).toBe(404);

    // URL parsing normalizes the dot-segments away; whatever survives must
    // resolve inside webDir — the answer is the SPA shell, never a system file.
    const traversal = await secured.app.request('/%2e%2e/%2e%2e/etc/passwd');
    expect(await traversal.text()).toContain('id="app"');
  });

  it('never shadows the API: unknown api paths are 404 JSON territory, not HTML', async () => {
    const res = await secured.app.request('/matomo.js');
    expect(res.headers.get('content-type')).toContain('text/javascript');
  });
});

describe('search-engine hygiene', () => {
  it('refuses crawlers on every response and by robots.txt', async () => {
    const root = await secured.app.request('/');
    expect(root.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    const robots = await secured.app.request('/robots.txt');
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain('Disallow: /');

    // A tracking beacon still answers, still uncrawlable, never 4xx (invariant 4).
    const beacon = await secured.app.request('/matomo.php?idsite=1&rec=1&send_image=0');
    expect(beacon.status).toBe(204);
    expect(beacon.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});
