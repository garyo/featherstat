import { DAY_MS, type MagicLinkMinted, type ViewerInfo } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { createSecuredApp, type SecuredApp } from '../auth/app.ts';
import { VIEWER_SESSION_TTL_MS } from '../auth/session.ts';
import type { Db } from '../db/index.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';

/**
 * The viewer lifecycle (docs/04 § 5): invite → claim → scoped reads →
 * re-claim refused → expiry → revocation. The admin wall and the claim
 * rate limit close the file.
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

async function invite(
  sites: 'all' | number[],
  email = 'client@example.com',
): Promise<MagicLinkMinted> {
  const admin = await adminSession();
  const res = await secured.app.request('/api/admin/viewers', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: admin.cookie,
      'x-csrf-token': admin.csrf,
    },
    body: JSON.stringify({ email, sites }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as MagicLinkMinted;
}

async function claim(url: string): Promise<Response> {
  return await secured.app.request(url);
}

describe('viewer lifecycle', () => {
  it('invite → claim → scoped reads; the used link never claims again', async () => {
    const minted = await invite([2]);
    expect(minted.url).toMatch(/^\/invite\/fsv_[A-Za-z0-9_-]{43}$/);
    expect(minted.expiresAt).toBe(T0 + 7 * DAY_MS);

    const claimed = await claim(minted.url);
    expect(claimed.status).toBe(302);
    expect(claimed.headers.get('location')).toBe('/');
    const cookie = cookiesOf(claimed);
    expect(cookie).toContain('__Host-session=');
    expect(cookie).toContain('__Host-csrf='); // the /me flow expects the pair

    // Scoped reads work; the directory shows only the viewer's sites.
    const sites = await secured.app.request('/api/sites', { headers: { cookie } });
    expect(sites.status).toBe(200);
    expect(((await sites.json()) as Array<{ id: number }>).map((s) => s.id)).toEqual([2]);

    // /me answers as an authenticated viewer, so the SPA can adapt.
    const me = await secured.app.request('/api/admin/me', { headers: { cookie } });
    const body = (await me.json()) as { authenticated: boolean; principal?: string; csrf?: string };
    expect(body.authenticated).toBe(true);
    expect(body.principal).toBe('viewer');
    expect(body.csrf).toBeTruthy();

    // Single use: the same link is dead, however soon it comes back.
    expect((await claim(minted.url)).status).toBe(410);
  });

  it('answers malformed and unknown tokens exactly like used ones', async () => {
    await invite([1]);
    expect((await claim('/invite/not-a-token')).status).toBe(410);
    expect((await claim(`/invite/fsv_${'A'.repeat(43)}`)).status).toBe(410);
  });

  it('refuses an expired link', async () => {
    const minted = await invite([1]);
    clock = minted.expiresAt; // expiry is exclusive: expires_at > now must fail
    expect((await claim(minted.url)).status).toBe(410);
  });

  it('revocation kills the outstanding link and re-invite restores access', async () => {
    const minted = await invite([1]);
    const admin = await adminSession();
    const revoke = await secured.app.request(`/api/admin/viewers/${minted.viewerId}`, {
      method: 'DELETE',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(revoke.status).toBe(200);
    expect((await claim(minted.url)).status).toBe(410);

    const listed = await secured.app.request('/api/admin/viewers', {
      headers: { cookie: admin.cookie },
    });
    const rows = (await listed.json()) as ViewerInfo[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBe(clock);

    // Same email again = re-invite: revocation clears, the fresh link claims.
    const reinvited = await invite([1, 2]);
    expect(reinvited.viewerId).toBe(minted.viewerId);
    expect((await claim(reinvited.url)).status).toBe(302);
    const after = await secured.app.request('/api/admin/viewers', {
      headers: { cookie: admin.cookie },
    });
    const rowsAfter = (await after.json()) as ViewerInfo[];
    expect(rowsAfter[0]?.revokedAt).toBeNull();
    expect(rowsAfter[0]?.sites).toEqual([1, 2]);
  });

  it('re-mints for a live viewer and 404s a revoked one', async () => {
    const minted = await invite([1]);
    const admin = await adminSession();
    const remint = await secured.app.request(`/api/admin/viewers/${minted.viewerId}/invite`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(remint.status).toBe(201);
    const second = (await remint.json()) as MagicLinkMinted;
    expect(second.url).not.toBe(minted.url);
    expect((await claim(second.url)).status).toBe(302);

    await secured.app.request(`/api/admin/viewers/${minted.viewerId}`, {
      method: 'DELETE',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    const dead = await secured.app.request(`/api/admin/viewers/${minted.viewerId}/invite`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(dead.status).toBe(404);
  });

  it('slides the session: an active viewer never expires, an absent one does', async () => {
    const minted = await invite([1]);
    const cookie = cookiesOf(await claim(minted.url));

    // Past half the 90-day TTL: the read succeeds AND renews the session…
    clock = T0 + VIEWER_SESSION_TTL_MS * 0.6;
    expect((await secured.app.request('/api/sites', { headers: { cookie } })).status).toBe(200);
    // …so a moment past the ORIGINAL expiry the session is still alive.
    clock = T0 + VIEWER_SESSION_TTL_MS * 1.2;
    expect((await secured.app.request('/api/sites', { headers: { cookie } })).status).toBe(200);
    // 90 days of true absence still ends it.
    clock += VIEWER_SESSION_TTL_MS;
    expect((await secured.app.request('/api/sites', { headers: { cookie } })).status).toBe(401);
  });

  it('keeps the whole viewer surface behind the admin wall', async () => {
    const minted = await invite('all');
    const cookie = cookiesOf(await claim(minted.url));
    for (const [path, method] of [
      ['/api/admin/viewers', 'GET'],
      ['/api/admin/viewers', 'POST'],
      [`/api/admin/viewers/${minted.viewerId}/invite`, 'POST'],
      [`/api/admin/viewers/${minted.viewerId}`, 'DELETE'],
    ] as const) {
      const res = await secured.app.request(path, {
        method,
        headers: { cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // No auth at all is a 401 — the prefix gate, before the wall.
    expect((await secured.app.request('/api/admin/viewers')).status).toBe(401);
  });

  it('rate-limits claim attempts per IP', async () => {
    await invite([1]);
    const probe = () =>
      secured.app.request(`/invite/fsv_${'A'.repeat(43)}`, {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
    for (let i = 0; i < 10; i += 1) expect((await probe()).status).toBe(410);
    expect((await probe()).status).toBe(429);
    // Another address keeps its own budget.
    const other = await secured.app.request(`/invite/fsv_${'A'.repeat(43)}`, {
      headers: { 'x-forwarded-for': '203.0.113.8' },
    });
    expect(other.status).toBe(410);
  });
});
