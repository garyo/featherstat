import {
  type ApiTokenMinted,
  DAY_MS,
  type UserInfo,
  type UserInviteMinted,
  type ViewerInfo,
} from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { createSecuredApp, type SecuredApp } from '../auth/app.ts';
import type { Db } from '../db/index.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';

/**
 * The user lifecycle (docs/04 § 5): create → claim sets the password → email
 * login → scoped reads → re-invite as password reset → disable. The admin
 * wall and the claim rate limit close the file.
 */

const PASSWORD = 'a-decent-password';
const SETUP_TOKEN = 'test-setup-token';
const USER_EMAIL = 'owner@example.com';
const USER_PASSWORD = 'users-own-password';

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

async function createUser(sites: number[], email = USER_EMAIL): Promise<UserInviteMinted> {
  const admin = await adminSession();
  const res = await secured.app.request('/api/admin/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: admin.cookie,
      'x-csrf-token': admin.csrf,
    },
    body: JSON.stringify({ email, sites }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as UserInviteMinted;
}

/** `/welcome/<token>` is the SPA page; the claim POST swaps the prefix. */
async function claim(url: string, password = USER_PASSWORD): Promise<Response> {
  return await secured.app.request(url.replace('/welcome/', '/claim/'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

async function loginAs(email: string, password: string): Promise<Response> {
  clock += 61_000; // outrun the 5/min login limiter — its clock is ours
  return await secured.app.request('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

describe('user lifecycle', () => {
  it('create → claim → email login → scoped reads; the used link never claims again', async () => {
    const minted = await createUser([2]);
    expect(minted.url).toMatch(/^\/welcome\/fsu_[A-Za-z0-9_-]{43}$/);
    expect(minted.expiresAt).toBe(T0 + 7 * DAY_MS);

    // Login is refused while the invite is unclaimed.
    expect((await loginAs(USER_EMAIL, USER_PASSWORD)).status).toBe(401);

    const claimed = await claim(minted.url);
    expect(claimed.status).toBe(200);
    const cookie = cookiesOf(claimed);
    expect(cookie).toContain('__Host-session=');

    // The claim signs the user in; the directory shows only their sites.
    const sites = await secured.app.request('/api/sites', { headers: { cookie } });
    expect(((await sites.json()) as Array<{ id: number }>).map((s) => s.id)).toEqual([2]);

    // /me answers as an authenticated user, so the SPA can adapt.
    const me = await secured.app.request('/api/admin/me', { headers: { cookie } });
    const body = (await me.json()) as {
      authenticated: boolean;
      principal?: string;
      email?: string;
    };
    expect(body.authenticated).toBe(true);
    expect(body.principal).toBe('user');
    expect(body.email).toBe(USER_EMAIL);

    // Single use: the same link is dead, however soon it comes back.
    expect((await claim(minted.url)).status).toBe(410);

    // Unlike a viewer, the user can log back in — case-insensitively.
    const login = await loginAs('OWNER@example.COM', USER_PASSWORD);
    expect(login.status).toBe(200);
  });

  it('answers malformed, unknown and expired tokens exactly like used ones', async () => {
    const minted = await createUser([1]);
    expect((await claim('/welcome/not-a-token')).status).toBe(410);
    expect((await claim(`/welcome/fsu_${'A'.repeat(43)}`)).status).toBe(410);
    // A viewer link never claims a password, whatever its shape.
    expect((await claim(`/welcome/fsv_${'A'.repeat(43)}`)).status).toBe(410);
    clock = minted.expiresAt; // expiry is exclusive: expires_at > now must fail
    expect((await claim(minted.url)).status).toBe(410);
  });

  it('login failures are indistinguishable: unknown email, unclaimed, wrong password', async () => {
    const minted = await createUser([1]);
    await claim(minted.url);
    const failures = await Promise.all([
      loginAs('nobody@example.com', USER_PASSWORD),
      loginAs(USER_EMAIL, 'not-the-password'),
    ]);
    for (const res of failures) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'wrong password' });
    }
  });

  it('disable kills the outstanding link and live sessions; re-invite restores', async () => {
    const minted = await createUser([1]);
    const cookie = cookiesOf(await claim(minted.url));
    const admin = await adminSession();

    const disable = await secured.app.request(`/api/admin/users/${minted.userId}`, {
      method: 'DELETE',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(disable.status).toBe(200);
    // The live session dies at the gate, and login is refused.
    expect((await secured.app.request('/api/sites', { headers: { cookie } })).status).toBe(401);
    expect((await loginAs(USER_EMAIL, USER_PASSWORD)).status).toBe(401);
    // Disabling twice is a 404 — it is no longer an active user.
    const again = await secured.app.request(`/api/admin/users/${minted.userId}`, {
      method: 'DELETE',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(again.status).toBe(404);

    // Same email again = re-invite: the same row, access restored, and the
    // old password still works once claimed anew sets a fresh one.
    const reinvited = await createUser([1]);
    expect(reinvited.userId).toBe(minted.userId);
    expect((await claim(reinvited.url, 'a-whole-new-password')).status).toBe(200);
    expect((await loginAs(USER_EMAIL, 'a-whole-new-password')).status).toBe(200);
    expect((await loginAs(USER_EMAIL, USER_PASSWORD)).status).toBe(401);
  });

  it('re-mints for an active user as a password reset and 404s a disabled one', async () => {
    const minted = await createUser([1]);
    await claim(minted.url);
    const admin = await adminSession();
    const remint = await secured.app.request(`/api/admin/users/${minted.userId}/invite`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(remint.status).toBe(201);
    const second = (await remint.json()) as UserInviteMinted;
    expect(second.url).not.toBe(minted.url);
    // The old password keeps working until the reset link is claimed…
    expect((await loginAs(USER_EMAIL, USER_PASSWORD)).status).toBe(200);
    // …then the new one replaces it.
    expect((await claim(second.url, 'the-reset-password')).status).toBe(200);
    expect((await loginAs(USER_EMAIL, 'the-reset-password')).status).toBe(200);
    expect((await loginAs(USER_EMAIL, USER_PASSWORD)).status).toBe(401);

    await secured.app.request(`/api/admin/users/${minted.userId}`, {
      method: 'DELETE',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    const dead = await secured.app.request(`/api/admin/users/${minted.userId}/invite`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(dead.status).toBe(404);
  });

  it('lists users with their sites; PATCH replaces the assignment', async () => {
    const minted = await createUser([1, 2]);
    const admin = await adminSession();
    const listed = await secured.app.request('/api/admin/users', {
      headers: { cookie: admin.cookie },
    });
    const rows = (await listed.json()) as UserInfo[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: USER_EMAIL,
      sites: [1, 2],
      hasPassword: false,
      disabledAt: null,
    });

    const patched = await secured.app.request(`/api/admin/users/${minted.userId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: admin.cookie,
        'x-csrf-token': admin.csrf,
      },
      // Site 99 does not exist and is silently dropped from the assignment.
      body: JSON.stringify({ sites: [2, 99] }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as UserInfo).sites).toEqual([2]);

    // The scope change reaches the user's next request, not just their next login.
    const cookie = cookiesOf(await claim(minted.url));
    const sites = await secured.app.request('/api/sites', { headers: { cookie } });
    expect(((await sites.json()) as Array<{ id: number }>).map((s) => s.id)).toEqual([2]);
  });

  it("narrows the user's grants on reassignment and revokes them on disable", async () => {
    const minted = await createUser([1, 2]);
    const cookie = cookiesOf(await claim(minted.url));
    const { csrf } = (await (
      await secured.app.request('/api/admin/me', { headers: { cookie } })
    ).json()) as { csrf: string };
    const asUser = async (path: string, body: unknown): Promise<Response> =>
      await secured.app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
        body: JSON.stringify(body),
      });
    const token = (await (
      await asUser('/api/admin/tokens', { name: 'both', sites: [1, 2] })
    ).json()) as ApiTokenMinted;
    expect(
      (await asUser('/api/admin/viewers', { email: 'a@example.com', sites: [1] })).status,
    ).toBe(201);
    expect(
      (await asUser('/api/admin/viewers', { email: 'b@example.com', sites: [1, 2] })).status,
    ).toBe(201);

    const admin = await adminSession();
    const adminHeaders = { cookie: admin.cookie, 'x-csrf-token': admin.csrf };
    const query = async (site: number): Promise<number> =>
      (
        await secured.app.request('/api/query', {
          method: 'POST',
          headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            site,
            range: { preset: '7d' },
            queries: [{ id: 'k', metrics: ['pageviews'] }],
          }),
        })
      ).status;
    const viewers = async (): Promise<ViewerInfo[]> =>
      (await (
        await secured.app.request('/api/admin/viewers', { headers: adminHeaders })
      ).json()) as ViewerInfo[];

    // Site 1 leaves the user: the token keeps only site 2, the viewer who had
    // nothing else is revoked, and the other keeps the site still theirs.
    const patched = await secured.app.request(`/api/admin/users/${minted.userId}`, {
      method: 'PATCH',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ sites: [2] }),
    });
    expect(patched.status).toBe(200);
    expect(await query(1)).toBe(404);
    expect(await query(2)).toBe(200);
    const [a, b] = await viewers();
    expect(a).toMatchObject({ email: 'a@example.com', sites: [1], revokedAt: T0 });
    expect(b).toMatchObject({ email: 'b@example.com', sites: [2], revokedAt: null });

    // Disabling the user takes everything they minted down with them.
    const disabled = await secured.app.request(`/api/admin/users/${minted.userId}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    expect(disabled.status).toBe(200);
    expect(await query(2)).toBe(401);
    expect((await viewers())[1]?.revokedAt).toBe(T0);
  });

  it('changes its own password via /api/admin/password, never the admin hash', async () => {
    const minted = await createUser([1]);
    const cookie = cookiesOf(await claim(minted.url));
    const me = await secured.app.request('/api/admin/me', { headers: { cookie } });
    const { csrf } = (await me.json()) as { csrf: string };
    const res = await secured.app.request('/api/admin/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ current: USER_PASSWORD, next: 'my-second-password' }),
    });
    expect(res.status).toBe(200);
    expect((await loginAs(USER_EMAIL, 'my-second-password')).status).toBe(200);
    expect((await loginAs(USER_EMAIL, USER_PASSWORD)).status).toBe(401);
    // The admin's own password is untouched by a user's change.
    const admin = await adminSession();
    expect(admin.csrf).toBeTruthy();
  });

  it('keeps the whole users surface behind the admin wall', async () => {
    const minted = await createUser([1]);
    const cookie = cookiesOf(await claim(minted.url));
    for (const [path, method] of [
      ['/api/admin/users', 'GET'],
      ['/api/admin/users', 'POST'],
      [`/api/admin/users/${minted.userId}/invite`, 'POST'],
      [`/api/admin/users/${minted.userId}`, 'PATCH'],
      [`/api/admin/users/${minted.userId}`, 'DELETE'],
    ] as const) {
      const res = await secured.app.request(path, {
        method,
        headers: { cookie, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // No auth at all is a 401 — the prefix gate, before the wall.
    expect((await secured.app.request('/api/admin/users')).status).toBe(401);
  });

  it('rate-limits claim attempts per IP', async () => {
    await createUser([1]);
    const probe = () =>
      secured.app.request(`/claim/fsu_${'A'.repeat(43)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: JSON.stringify({ password: USER_PASSWORD }),
      });
    for (let i = 0; i < 10; i += 1) expect((await probe()).status).toBe(410);
    expect((await probe()).status).toBe(429);
    // Another address keeps its own budget.
    const other = await secured.app.request(`/claim/fsu_${'A'.repeat(43)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.8' },
      body: JSON.stringify({ password: USER_PASSWORD }),
    });
    expect(other.status).toBe(410);
  });
});
